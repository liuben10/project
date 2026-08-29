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
	Edges      []state.Edge      `json:"edges"`
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
	hydrateFromStore(st, live)
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
			msg, err := json.Marshal(wsSnapshotMessage{Type: "snapshot", Components: live.Snapshot(), Edges: live.EdgeSnapshot()})
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

// hydrateFromStore seeds live (in-memory) state from SQLite so components
// and edges already known from before a restart show up immediately,
// instead of only reappearing as each one happens to report again.
func hydrateFromStore(st *store.Store, live *state.Store) {
	if components, err := st.ListComponents(); err != nil {
		log.Printf("load persisted components: %v", err)
	} else {
		stateComponents := make([]state.Component, len(components))
		for i, c := range components {
			stateComponents[i] = state.Component{ID: c.ID, Name: c.Name, Type: c.Type}
		}
		live.LoadComponents(stateComponents)
	}

	if edges, err := st.ListEdges(); err != nil {
		log.Printf("load persisted edges: %v", err)
	} else {
		stateEdges := make([]state.Edge, len(edges))
		for i, e := range edges {
			stateEdges[i] = state.Edge{Source: e.Source, Destination: e.Destination, LastSeenNano: e.LastSeenNano, Count: e.Count}
		}
		live.LoadEdges(stateEdges)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
