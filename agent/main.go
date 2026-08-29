// Command agent runs inside (or alongside) an application container,
// collects that container's resource usage from cgroup v2, and exports it
// as OTLP metrics to the distviz backend.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/metric"
	metricsdk "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"

	"distviz/agent/internal/collector"
	"distviz/agent/internal/relay"
)

// promMetricSets maps a PROM_METRIC_SET name to the Prometheus series this
// agent knows how to translate into OTLP metrics. Add an entry here for
// each new component type that exposes a Prometheus scrape endpoint.
var promMetricSets = map[string][]collector.PromMetric{
	"kafka": {
		{PromName: "kafka_messages_in_per_second", Name: "kafka.messages.in", Unit: "1/s"},
		{PromName: "kafka_bytes_in_per_second", Name: "kafka.bytes.in", Unit: "By/s"},
		{PromName: "kafka_bytes_out_per_second", Name: "kafka.bytes.out", Unit: "By/s"},
	},
	// Micrometer/Spring Boot Actuator's Prometheus endpoint. Both are Summary-typed series
	// (parsed under their base name, without a "_count" suffix - see metricValue in
	// promscrape.go): http_server_requests_seconds is a cumulative request counter split
	// across every (method, uri, status) combination, summed here and converted to a rate;
	// http_server_requests_active_seconds is already an instantaneous in-flight-request count.
	"java-http": {
		{PromName: "http_server_requests_seconds", Name: "http.requests.rate", Unit: "1/s", Rate: true},
		{PromName: "http_server_requests_active_seconds", Name: "http.requests.active", Unit: "1"},
	},
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	componentName := envOr("COMPONENT_NAME", hostnameOr("unknown-component"))
	componentType := envOr("COMPONENT_TYPE", "app-server")
	backendEndpoint := envOr("BACKEND_ENDPOINT", "localhost:8080")
	cgroupRoot := envOr("CGROUP_ROOT", "/sys/fs/cgroup")
	interval := envDurationOr("POLL_INTERVAL", 5*time.Second)

	res, err := resource.New(ctx, resource.WithAttributes(
		attribute.String("service.name", componentName),
		attribute.String("component.type", componentType),
	))
	if err != nil {
		log.Fatalf("build resource: %v", err)
	}

	exporter, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpoint(backendEndpoint),
		otlpmetrichttp.WithInsecure(),
	)
	if err != nil {
		log.Fatalf("create OTLP exporter: %v", err)
	}

	reader := metricsdk.NewPeriodicReader(exporter, metricsdk.WithInterval(interval))
	provider := metricsdk.NewMeterProvider(metricsdk.WithReader(reader), metricsdk.WithResource(res))
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := provider.Shutdown(shutdownCtx); err != nil {
			log.Printf("provider shutdown: %v", err)
		}
	}()

	meter := provider.Meter("distviz-agent")
	col := collector.New(cgroupRoot)

	cpuUsage, err := meter.Float64ObservableGauge("container.cpu.usage", metric.WithUnit("cores"))
	if err != nil {
		log.Fatalf("create cpu.usage gauge: %v", err)
	}
	cpuUtilization, err := meter.Float64ObservableGauge("container.cpu.utilization", metric.WithUnit("1"))
	if err != nil {
		log.Fatalf("create cpu.utilization gauge: %v", err)
	}
	memUsage, err := meter.Float64ObservableGauge("container.memory.usage", metric.WithUnit("By"))
	if err != nil {
		log.Fatalf("create memory.usage gauge: %v", err)
	}
	memLimit, err := meter.Float64ObservableGauge("container.memory.limit", metric.WithUnit("By"))
	if err != nil {
		log.Fatalf("create memory.limit gauge: %v", err)
	}

	_, err = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		sample, err := col.Collect()
		if err != nil {
			log.Printf("collect cgroup sample: %v", err)
			return nil // skip this cycle rather than killing the export loop
		}
		o.ObserveFloat64(cpuUsage, sample.CPUCores)
		if sample.HasCPUUtilization {
			o.ObserveFloat64(cpuUtilization, sample.CPUUtilization)
		}
		o.ObserveFloat64(memUsage, sample.MemoryUsageBytes)
		if sample.MemoryLimitBytes > 0 {
			o.ObserveFloat64(memLimit, sample.MemoryLimitBytes)
		}
		return nil
	}, cpuUsage, cpuUtilization, memUsage, memLimit)
	if err != nil {
		log.Fatalf("register callback: %v", err)
	}

	promScrapeURL := envOr("PROM_SCRAPE_URL", "")
	promMetricSet := envOr("PROM_METRIC_SET", "")
	if promScrapeURL != "" {
		promMetrics, ok := promMetricSets[promMetricSet]
		if !ok {
			log.Fatalf("PROM_SCRAPE_URL is set but PROM_METRIC_SET=%q is not a known metric set", promMetricSet)
		}
		if err := registerPromScrape(meter, promScrapeURL, promMetrics); err != nil {
			log.Fatalf("register prometheus scrape: %v", err)
		}
		log.Printf("scraping prometheus metrics: url=%s set=%s", promScrapeURL, promMetricSet)
	}

	receiverAddr := envOr("RECEIVER_ADDR", ":4318")
	relayServer := &http.Server{
		Addr:    receiverAddr,
		Handler: relay.Handler(fmt.Sprintf("http://%s/v1/metrics", backendEndpoint)),
	}
	go func() {
		if err := relayServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("relay server error: %v", err)
		}
	}()

	log.Printf("distviz agent started: component=%s type=%s backend=%s interval=%s cgroup_root=%s receiver=%s",
		componentName, componentType, backendEndpoint, interval, cgroupRoot, receiverAddr)

	<-ctx.Done()
	log.Println("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := relayServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("relay server shutdown: %v", err)
	}
}

// registerPromScrape declares one observable gauge per configured metric and
// a callback that scrapes the endpoint once per collection cycle to fill
// them in. Metrics absent from a given scrape (e.g. exporter not warmed up
// yet) are simply skipped for that cycle.
func registerPromScrape(meter metric.Meter, url string, metrics []collector.PromMetric) error {
	scraper := collector.NewPromScraper(url, metrics)

	gauges := make(map[string]metric.Float64ObservableGauge, len(metrics))
	instruments := make([]metric.Observable, 0, len(metrics))
	for _, m := range metrics {
		g, err := meter.Float64ObservableGauge(m.Name, metric.WithUnit(m.Unit))
		if err != nil {
			return fmt.Errorf("create gauge %s: %w", m.Name, err)
		}
		gauges[m.Name] = g
		instruments = append(instruments, g)
	}

	_, err := meter.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
		values, err := scraper.Collect(ctx)
		if err != nil {
			log.Printf("scrape %s: %v", url, err)
			return nil // skip this cycle rather than killing the export loop
		}
		for name, value := range values {
			o.ObserveFloat64(gauges[name], value)
		}
		return nil
	}, instruments...)
	return err
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envDurationOr(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(secs) * time.Second
	}
	if d, err := time.ParseDuration(v); err == nil {
		return d
	}
	return fallback
}

func hostnameOr(fallback string) string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return fallback
}
