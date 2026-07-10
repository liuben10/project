// promscrape lets the agent pull metrics out of any component that already
// exposes a Prometheus text-exposition endpoint (JMX exporter, Micrometer's
// Actuator endpoint, postgres exporter, etc.) rather than requiring every
// integration to speak OTLP natively.
package collector

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
)

// PromMetric maps one scraped Prometheus series (or family of series) onto
// a friendly metric name reported by this agent.
type PromMetric struct {
	PromName string            // metric name as it appears in the scrape output
	Name     string            // name to report (e.g. "kafka.messages.in")
	Unit     string            // OTel unit string (e.g. "1/s", "By/s")
	Labels   map[string]string // if set, only series matching these label values are included

	// Rate, when true, reports the per-second rate of change of a
	// cumulative counter (e.g. Micrometer's http_server_requests_seconds_count)
	// instead of its raw ever-increasing value. Leave false for metrics
	// that are already a rate or an instantaneous gauge (e.g. the JMX
	// exporter's OneMinuteRate attributes, or a thread-pool gauge).
	Rate bool
}

type sample struct {
	value float64
	at    time.Time
}

type PromScraper struct {
	url     string
	client  *http.Client
	metrics []PromMetric

	mu   sync.Mutex
	prev map[string]sample // keyed by PromMetric.Name, for Rate metrics
}

func NewPromScraper(url string, metrics []PromMetric) *PromScraper {
	return &PromScraper{url: url, client: &http.Client{}, metrics: metrics, prev: make(map[string]sample)}
}

// Collect scrapes the endpoint once and returns the configured metrics that
// were found, keyed by their reported Name. A metric with Rate set is
// omitted on its first observation, since a rate needs two samples.
func (p *PromScraper) Collect(ctx context.Context) (map[string]float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return nil, fmt.Errorf("build scrape request: %w", err)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("scrape %s: %w", p.url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("scrape %s: unexpected status %s", p.url, resp.Status)
	}

	parser := expfmt.NewTextParser(model.LegacyValidation)
	families, err := parser.TextToMetricFamilies(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("parse scrape output: %w", err)
	}

	now := time.Now()
	out := make(map[string]float64, len(p.metrics))

	p.mu.Lock()
	defer p.mu.Unlock()

	for _, want := range p.metrics {
		mf, ok := families[want.PromName]
		if !ok {
			continue
		}

		// A single metric name (e.g. http_server_requests_seconds_count) is
		// usually split across many series, one per label combination
		// (method, uri, status...). Sum whatever matches so callers get one
		// aggregate number rather than an arbitrary single series.
		var sum float64
		var found bool
		for _, m := range mf.GetMetric() {
			if !labelsMatch(m.GetLabel(), want.Labels) {
				continue
			}
			sum += metricValue(m)
			found = true
		}
		if !found {
			continue
		}

		if !want.Rate {
			out[want.Name] = sum
			continue
		}

		prev, hadPrev := p.prev[want.Name]
		p.prev[want.Name] = sample{value: sum, at: now}
		if !hadPrev {
			continue
		}
		elapsed := now.Sub(prev.at).Seconds()
		if elapsed <= 0 {
			continue
		}
		delta := sum - prev.value
		if delta < 0 {
			// counter reset (e.g. app restart) - skip this cycle rather
			// than report a bogus negative rate.
			continue
		}
		out[want.Name] = delta / elapsed
	}
	return out, nil
}

func labelsMatch(pairs []*dto.LabelPair, want map[string]string) bool {
	if len(want) == 0 {
		return true
	}
	got := make(map[string]string, len(pairs))
	for _, p := range pairs {
		got[p.GetName()] = p.GetValue()
	}
	for k, v := range want {
		if got[k] != v {
			return false
		}
	}
	return true
}

// metricValue extracts a single number from a scraped series. Prometheus's
// text parser only exposes Gauge/Counter/Untyped as top-level metric types;
// Summary and Histogram series (e.g. Micrometer's Timer-backed
// http_server_requests_seconds, exposed as "..._count"/"..._sum" in text
// form) are parsed as one family keyed by the *base* name, with the count
// living in Summary.SampleCount / Histogram.SampleCount instead. We want the
// count (an approximation of a Counter) in both cases.
func metricValue(m *dto.Metric) float64 {
	switch {
	case m.Gauge != nil:
		return m.Gauge.GetValue()
	case m.Counter != nil:
		return m.Counter.GetValue()
	case m.Untyped != nil:
		return m.Untyped.GetValue()
	case m.Summary != nil:
		return float64(m.Summary.GetSampleCount())
	case m.Histogram != nil:
		return float64(m.Histogram.GetSampleCount())
	default:
		return 0
	}
}
