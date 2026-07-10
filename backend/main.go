// Command backend runs the distviz ingest server: it accepts OTLP metric
// exports from agents, persists them, and serves a live dashboard.
package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"

	"distviz/backend/internal/api"
	"distviz/backend/internal/hub"
	"distviz/backend/internal/ingest"
	"distviz/backend/internal/state"
	"distviz/backend/internal/store"
)

//go:embed web
var webFS embed.FS

type wsSnapshotMessage struct {
	Type       string            `json:"type"`
	Components []state.Component `json:"components"`
}

func main() {
	addr := envOr("LISTEN_ADDR", ":8080")
	dbPath := envOr("DB_PATH", "distviz.db")

	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	live := state.New()
	h := hub.New()

	ingestHandler := ingest.NewHandler(st, live)
	ingestHandler.Broadcast = h.Broadcast

	apiHandler := api.NewHandler(live)

	staticFS, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("mount web assets: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/v1/metrics", ingestHandler)
	mux.HandleFunc("/api/components", apiHandler.Components)
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		h.ServeWS(w, r, func() []byte {
			msg, err := json.Marshal(wsSnapshotMessage{Type: "snapshot", Components: live.Snapshot()})
			if err != nil {
				return nil
			}
			return msg
		})
	})
	mux.Handle("/", http.FileServer(http.FS(staticFS)))

	log.Printf("distviz backend listening on %s (db=%s)", addr, dbPath)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
