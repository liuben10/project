// Package ingest decodes OTLP/HTTP metric export requests (standard
// OpenTelemetry wire format) and applies the datapoints to live state and
// persistent storage.
package ingest

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	collectorpb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	metricspb "go.opentelemetry.io/proto/otlp/metrics/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/proto"

	"distviz/backend/internal/state"
	"distviz/backend/internal/store"
)

// Resource attribute keys that identify a component. Any OTLP-instrumented
// process can populate these to appear on the dashboard.
const (
	attrServiceName   = "service.name"
	attrComponentType = "component.type"
)

type Handler struct {
	store *store.Store
	state *state.Store
	// Broadcast is called with a JSON-encoded update message after each
	// batch of datapoints has been applied.
	Broadcast func(message []byte)
}

func NewHandler(s *store.Store, st *state.Store) *Handler {
	return &Handler{store: s, state: st}
}

type wsUpdateMessage struct {
	Type      string          `json:"type"`
	Component state.Component `json:"component"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	var req collectorpb.ExportMetricsServiceRequest
	if err := proto.Unmarshal(body, &req); err != nil {
		http.Error(w, fmt.Sprintf("invalid OTLP payload: %v", err), http.StatusBadRequest)
		return
	}

	for _, rm := range req.GetResourceMetrics() {
		componentID, componentName, componentType := resourceIdentity(rm.GetResource())
		if componentID == "" {
			continue // no service.name, can't attribute these metrics to a component
		}

		var lastTs int64
		for _, sm := range rm.GetScopeMetrics() {
			for _, m := range sm.GetMetrics() {
				for _, dp := range numberDataPoints(m) {
					ts := int64(dp.GetTimeUnixNano())
					point := state.MetricPoint{Value: numberValue(dp), Unit: m.GetUnit(), TsUnixNano: ts}

					updated := h.state.Apply(componentID, componentName, componentType, m.GetName(), point)

					if err := h.store.InsertDatapoint(store.Datapoint{
						ComponentID: componentID,
						MetricName:  m.GetName(),
						Value:       point.Value,
						Unit:        point.Unit,
						TsUnixNano:  ts,
					}); err != nil {
						log.Printf("insert datapoint: %v", err)
					}

					if h.Broadcast != nil {
						msg, err := json.Marshal(wsUpdateMessage{Type: "update", Component: updated})
						if err == nil {
							h.Broadcast(msg)
						}
					}
					lastTs = ts
				}
			}
		}

		if lastTs > 0 {
			if err := h.store.UpsertComponent(store.Component{
				ID: componentID, Name: componentName, Type: componentType,
				FirstSeenNano: lastTs, LastSeenNano: lastTs,
			}); err != nil {
				log.Printf("upsert component: %v", err)
			}
		}
	}

	w.WriteHeader(http.StatusOK)
	// Empty ExportMetricsServiceResponse is a valid, empty protobuf body.
}

func resourceIdentity(res *resourcepb.Resource) (id, name, typ string) {
	if res == nil {
		return "", "", ""
	}
	for _, kv := range res.GetAttributes() {
		switch kv.GetKey() {
		case attrServiceName:
			name = stringValue(kv.GetValue())
		case attrComponentType:
			typ = stringValue(kv.GetValue())
		}
	}
	id = name // service.name is the component identity for the MVP
	return id, name, typ
}

func stringValue(v *commonpb.AnyValue) string {
	if v == nil {
		return ""
	}
	return v.GetStringValue()
}

func numberDataPoints(m *metricspb.Metric) []*metricspb.NumberDataPoint {
	if g := m.GetGauge(); g != nil {
		return g.GetDataPoints()
	}
	if s := m.GetSum(); s != nil {
		return s.GetDataPoints()
	}
	return nil
}

func numberValue(dp *metricspb.NumberDataPoint) float64 {
	if dp == nil {
		return 0
	}
	switch v := dp.GetValue().(type) {
	case *metricspb.NumberDataPoint_AsDouble:
		return v.AsDouble
	case *metricspb.NumberDataPoint_AsInt:
		return float64(v.AsInt)
	default:
		return 0
	}
}
