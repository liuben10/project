// Package relay implements a minimal local OTLP/HTTP receiver: it accepts
// metrics POSTed by processes running alongside the agent (e.g. this app's
// own client libraries) and forwards them unmodified to the backend, so app
// code can report custom metrics without knowing the backend's address or
// implementing its own export/retry logic. This is the "app -> agent" leg
// of the pipeline; the agent's own collectors already handle "agent ->
// backend" for cgroup/Prometheus-scraped metrics.
package relay

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"time"
)

func Handler(backendURL string) http.Handler {
	client := &http.Client{Timeout: 5 * time.Second}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}

		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, backendURL, bytes.NewReader(body))
		if err != nil {
			http.Error(w, fmt.Sprintf("build relay request: %v", err), http.StatusInternalServerError)
			return
		}
		req.Header.Set("Content-Type", r.Header.Get("Content-Type"))

		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, fmt.Sprintf("relay to backend: %v", err), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})
}
