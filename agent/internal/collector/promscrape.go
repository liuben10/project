// promscrape lets the agent pull metrics out of any component that already
// exposes a Prometheus text-exposition endpoint (JMX exporter, postgres
// exporter, redis exporter, etc.) rather than requiring every integration
// to speak OTLP natively.
package collector

import (
	"context"
	"fmt"
	"net/http"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
)

// PromMetric maps one scraped Prometheus series onto a friendly metric name
// reported by this agent.
type PromMetric struct {
	PromName string            // metric name as it appears in the scrape output
	Name     string            // name to report (e.g. "kafka.messages.in")
	Unit     string            // OTel unit string (e.g. "1/s", "By/s")
	Labels   map[string]string // if set, only match a series with these label values
}

type PromScraper struct {
	url     string
	client  *http.Client
	metrics []PromMetric
}

func NewPromScraper(url string, metrics []PromMetric) *PromScraper {
	return &PromScraper{url: url, client: &http.Client{}, metrics: metrics}
}

// Collect scrapes the endpoint once and returns the configured metrics that
// were found, keyed by their reported Name.
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

	out := make(map[string]float64, len(p.metrics))
	for _, want := range p.metrics {
		mf, ok := families[want.PromName]
		if !ok {
			continue
		}
		for _, m := range mf.GetMetric() {
			if !labelsMatch(m.GetLabel(), want.Labels) {
				continue
			}
			out[want.Name] = metricValue(m)
			break
		}
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

func metricValue(m *dto.Metric) float64 {
	switch {
	case m.Gauge != nil:
		return m.Gauge.GetValue()
	case m.Counter != nil:
		return m.Counter.GetValue()
	case m.Untyped != nil:
		return m.Untyped.GetValue()
	default:
		return 0
	}
}
