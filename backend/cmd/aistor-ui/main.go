// Command aistor-ui serves the AIStor catalog web UI and its backend-for-frontend API.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/arturborycki/aistore-ui/backend/internal/audit"
	"github.com/arturborycki/aistore-ui/backend/internal/config"
	"github.com/arturborycki/aistore-ui/backend/internal/server"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
	"github.com/arturborycki/aistore-ui/backend/internal/web"
)

var version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "aistor-ui:", err)
		os.Exit(1)
	}
}

func run() error {
	cfgPath := flag.String("config", envOr("AISTOR_UI_CONFIG", "/etc/aistor-ui/config.yaml"), "path to the configuration file")
	check := flag.Bool("check-config", false, "validate the configuration and exit")
	showVersion := flag.Bool("version", false, "print the version and exit")
	healthcheck := flag.String("healthcheck", "", "probe the given URL (e.g. http://127.0.0.1:8080/healthz), or \"auto\" for this server's own listener, and exit 0 if healthy; for container health checks")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return nil
	}
	if *healthcheck != "" {
		target := *healthcheck
		c := &http.Client{Timeout: 3 * time.Second}
		if target == "auto" {
			cfg, err := config.Load(*cfgPath)
			if err != nil {
				return err
			}
			if target, err = healthURL(cfg); err != nil {
				return err
			}
		}
		resp, err := c.Get(target)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			return fmt.Errorf("unhealthy: HTTP %d", resp.StatusCode)
		}
		return nil
	}

	level := slog.LevelInfo
	if os.Getenv("AISTOR_UI_DEBUG") == "1" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	if *check {
		fmt.Println("configuration OK")
		return nil
	}

	keys := make([]session.KeyMaterial, 0, len(cfg.Session.Keys))
	for _, k := range cfg.Session.Keys {
		keys = append(keys, session.KeyMaterial{ID: k.ID, Key: k.Bytes()})
	}
	kr, err := session.NewKeyring(keys)
	if err != nil {
		return err
	}

	var store session.Store
	var auditStore audit.Store
	var redisClient redis.UniversalClient
	if cfg.Session.Store == "memory" {
		store = session.NewMemoryStore()
		auditStore = audit.NewMemoryStore(cfg.Audit.Retain)
		log.Warn("using in-memory session store: sessions are lost on restart and cannot be shared between replicas")
	} else {
		rs, err := session.NewRedisStore(cfg.Session.Store)
		if err != nil {
			return fmt.Errorf("session store: %w", err)
		}
		store = rs
		redisClient = rs.Client()
		auditStore = audit.NewRedisStore(rs.Client(), cfg.Audit.Retain)
	}

	srv, err := server.New(server.Options{
		Config:   cfg,
		Log:      log,
		Sessions: session.NewManager(store, kr, cfg.Session.IdleTimeout, cfg.Session.AbsoluteTTL),
		Audit:    audit.NewLogger(log, auditStore, cfg.Audit.WebhookURL, audit.WithWebhookSecret(cfg.Audit.WebhookSecret)),
		Redis:    redisClient,
		Static:   web.FS(),
		Version:  version,
	})
	if err != nil {
		return err
	}

	httpSrv := &http.Server{
		Addr:              cfg.Server.Listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	var metricsSrv *http.Server
	if cfg.Server.MetricsListen != "" {
		mux := http.NewServeMux()
		mux.Handle("/metrics", srv.Metrics())
		mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
		metricsSrv = &http.Server{Addr: cfg.Server.MetricsListen, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("metrics listener failed", "err", err)
			}
		}()
	}

	if cfg.Server.TLSSelfSigned {
		if err := ensureSelfSigned(cfg, log); err != nil {
			return err
		}
	}

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Server.Listen, "publicUrl", cfg.Server.PublicURL, "version", version, "clusters", len(cfg.Clusters))
		var err error
		if cfg.Server.TLSCertFile != "" {
			err = httpSrv.ListenAndServeTLS(cfg.Server.TLSCertFile, cfg.Server.TLSKeyFile)
		} else {
			err = httpSrv.ListenAndServe()
		}
		if !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
		close(errc)
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errc:
		return err
	case sig := <-stop:
		log.Info("shutting down", "signal", sig.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if metricsSrv != nil {
		_ = metricsSrv.Shutdown(ctx)
	}
	return httpSrv.Shutdown(ctx)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
