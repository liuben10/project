// Package edgeclient lets application code report "I called this other
// system" to the local distviz agent, so it can be drawn as a dependency
// edge on the topology dashboard. This is deliberately not distributed
// tracing: it doesn't track every call or correlate requests end to end, it
// only samples enough to establish that a dependency exists between two
// systems and that it's still active.
//
// Reporter is the protocol-agnostic core - call Report(destination) directly
// from any client code (a Kafka producer/consumer, a database driver, etc).
// Tripper/WrapClient are a convenience wrapper for the common HTTP case.
package edgeclient

import (
	"bytes"
	"net/http"
	"os"
	"sync"
	"time"

	collectorpb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	metricspb "go.opentelemetry.io/proto/otlp/metrics/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/proto"
)

// MetricName is the well-known metric name the backend recognizes as an
// edge report rather than a per-component metric (see backend/internal/ingest).
const MetricName = "distviz.edge.calls"

// Reporter sends a sampled edge report to the local distviz agent for every
// distinct destination it's asked to report, without needing every single
// call to be tracked.
type Reporter struct {
	agentEndpoint string
	componentName string
	componentType string
	sampleEvery   time.Duration
	httpClient    *http.Client

	mu       sync.Mutex
	lastSent map[string]time.Time
}

type Option func(*Reporter)

// WithAgentEndpoint overrides where edge reports are sent. Defaults to
// http://localhost:4318, the local agent's OTLP relay.
func WithAgentEndpoint(endpoint string) Option {
	return func(r *Reporter) { r.agentEndpoint = endpoint }
}

// WithSampleInterval controls how often a *repeat* report to the same
// destination re-confirms the edge. The first report for a new destination
// is always sent immediately. Defaults to 30s.
func WithSampleInterval(d time.Duration) Option {
	return func(r *Reporter) { r.sampleEvery = d }
}

// NewReporter builds a Reporter. Component identity is read from the
// COMPONENT_NAME/COMPONENT_TYPE env vars, matching the convention the
// distviz agent itself uses.
func NewReporter(opts ...Option) *Reporter {
	r := &Reporter{
		agentEndpoint: "http://localhost:4318",
		componentName: os.Getenv("COMPONENT_NAME"),
		componentType: os.Getenv("COMPONENT_TYPE"),
		sampleEvery:   30 * time.Second,
		httpClient:    &http.Client{Timeout: 3 * time.Second},
		lastSent:      make(map[string]time.Time),
	}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// Report records that this component talked to destination (e.g. a
// hostname, or a logical system name like "kafka-broker"), subject to
// sampling. Safe to call on every message/request - most calls will be
// no-ops between sample windows.
func (r *Reporter) Report(destination string) {
	if destination == "" || r.componentName == "" {
		return
	}
	// Captured here, at the actual call site, rather than later inside the
	// async send - this is the real "last message time", not merely
	// whenever the goroutine below happened to get scheduled.
	messageTime := time.Now()

	r.mu.Lock()
	last, seen := r.lastSent[destination]
	if seen && time.Since(last) < r.sampleEvery {
		r.mu.Unlock()
		return
	}
	r.lastSent[destination] = messageTime
	r.mu.Unlock()

	// Fire and forget: an edge report is a best-effort signal, not
	// something the caller should ever wait on or fail for.
	go r.send(destination, messageTime)
}

func (r *Reporter) send(destination string, messageTime time.Time) {
	body, err := proto.Marshal(buildRequest(r.componentName, r.componentType, destination, messageTime))
	if err != nil {
		return
	}

	req, err := http.NewRequest(http.MethodPost, r.agentEndpoint+"/v1/metrics", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}

// Tripper wraps an http.RoundTripper, reporting a sampled edge for every
// distinct destination host it sees.
type Tripper struct {
	next     http.RoundTripper
	reporter *Reporter
}

// New wraps next (http.DefaultTransport if nil) with edge reporting.
func New(next http.RoundTripper, opts ...Option) *Tripper {
	if next == nil {
		next = http.DefaultTransport
	}
	return &Tripper{next: next, reporter: NewReporter(opts...)}
}

// WrapClient returns a shallow copy of c with its Transport instrumented
// for edge reporting. Pass nil to get a new client based on http.DefaultClient.
func WrapClient(c *http.Client, opts ...Option) *http.Client {
	if c == nil {
		c = http.DefaultClient
	}
	wrapped := *c
	wrapped.Transport = New(c.Transport, opts...)
	return &wrapped
}

func (t *Tripper) RoundTrip(req *http.Request) (*http.Response, error) {
	t.reporter.Report(req.URL.Hostname())
	return t.next.RoundTrip(req)
}

func buildRequest(componentName, componentType, destination string, messageTime time.Time) *collectorpb.ExportMetricsServiceRequest {
	return &collectorpb.ExportMetricsServiceRequest{
		ResourceMetrics: []*metricspb.ResourceMetrics{{
			Resource: &resourcepb.Resource{
				Attributes: []*commonpb.KeyValue{
					stringAttr("service.name", componentName),
					stringAttr("component.type", componentType),
				},
			},
			ScopeMetrics: []*metricspb.ScopeMetrics{{
				Metrics: []*metricspb.Metric{{
					Name: MetricName,
					Unit: "1",
					Data: &metricspb.Metric_Gauge{Gauge: &metricspb.Gauge{
						DataPoints: []*metricspb.NumberDataPoint{{
							Attributes:   []*commonpb.KeyValue{stringAttr("destination", destination)},
							TimeUnixNano: uint64(messageTime.UnixNano()),
							Value:        &metricspb.NumberDataPoint_AsDouble{AsDouble: 1},
						}},
					}},
				}},
			}},
		}},
	}
}

func stringAttr(key, value string) *commonpb.KeyValue {
	return &commonpb.KeyValue{
		Key:   key,
		Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
	}
}
