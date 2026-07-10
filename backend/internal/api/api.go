// Package api exposes read-only REST endpoints backing the dashboard.
package api

import (
	"encoding/json"
	"net/http"

	"distviz/backend/internal/state"
)

type Handler struct {
	state *state.Store
}

func NewHandler(st *state.Store) *Handler {
	return &Handler{state: st}
}

// Components returns the live snapshot of every known component.
func (h *Handler) Components(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(h.state.Snapshot())
}
