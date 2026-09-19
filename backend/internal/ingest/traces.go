package ingest

import (
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"time"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"

	"distviz/backend/internal/tracecorrelate"
)

// TracesHandler accepts standard OTLP/HTTP trace exports (POST /v1/traces)
// from any OpenTelemetry-instrumented app - typically an auto-instrumentation
// agent attached directly to the app, not this project's own agent, since
// there's nothing project-specific about ingesting a trace. Dependency
// edges are derived from real parent/child span relationships that cross a
// service.name boundary (see tracecorrelate), instead of a component
// self-reporting who it called.
type TracesHandler struct {
	tracker *tracecorrelate.Tracker
	// recordEdge persists and broadcasts a confirmed edge - pass
	// Handler.RecordEdge (ingest.go) so traces and metrics share the same
	// live state, storage, and WebSocket broadcast.
	recordEdge func(source, destination string, ts int64)
}

func NewTracesHandler(tracker *tracecorrelate.Tracker, recordEdge func(source, destination string, ts int64)) *TracesHandler {
	return &TracesHandler{tracker: tracker, recordEdge: recordEdge}
}

// Sweep should be called periodically (e.g. every few seconds) to bound how
// long the tracker holds onto spans still waiting for a parent or child.
func (h *TracesHandler) Sweep() {
	h.tracker.Sweep(time.Now())
}

func (h *TracesHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	var req collectortracepb.ExportTraceServiceRequest
	if err := proto.Unmarshal(body, &req); err != nil {
		http.Error(w, fmt.Sprintf("invalid OTLP payload: %v", err), http.StatusBadRequest)
		return
	}

	for _, rs := range req.GetResourceSpans() {
		serviceName, _, _ := resourceIdentity(rs.GetResource())
		if serviceName == "" {
			continue // no service.name, can't attribute these spans to a component
		}
		for _, ss := range rs.GetScopeSpans() {
			for _, span := range ss.GetSpans() {
				h.observeSpan(span, serviceName)
			}
		}
	}

	w.WriteHeader(http.StatusOK)
	// Empty ExportTraceServiceResponse is a valid, empty protobuf body.
}

func (h *TracesHandler) observeSpan(span *tracepb.Span, serviceName string) {
	spanID := hex.EncodeToString(span.GetSpanId())
	parentID := hex.EncodeToString(span.GetParentSpanId())
	if spanID == "" {
		return
	}
	at := time.Unix(0, int64(span.GetStartTimeUnixNano()))

	for _, edge := range h.tracker.Observe(spanID, parentID, serviceName, at) {
		h.recordEdge(edge.Source, edge.Destination, at.UnixNano())
	}
}
