package server

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type metrics struct {
	reg      *prometheus.Registry
	requests *prometheus.CounterVec
	latency  *prometheus.HistogramVec
}

func newMetrics() *metrics {
	reg := prometheus.NewRegistry()
	m := &metrics{
		reg: reg,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "aistor_ui_http_requests_total", Help: "HTTP requests by route and status.",
		}, []string{"method", "route", "status"}),
		latency: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "aistor_ui_http_request_duration_seconds", Help: "HTTP request latency by route.",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "route"}),
	}
	reg.MustRegister(m.requests, m.latency, collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}

func (m *metrics) observe(method, route string, status int, d time.Duration) {
	m.requests.WithLabelValues(method, route, strconv.Itoa(status)).Inc()
	m.latency.WithLabelValues(method, route).Observe(d.Seconds())
}

func (m *metrics) handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}
