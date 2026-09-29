// Package web embeds the built single-page application. The frontend build
// output is copied into dist/ before compiling (see the Dockerfile).
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS returns the SPA files rooted at dist/.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
