package com.distviz.demo.edge;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse.BodyHandlers;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest;
import io.opentelemetry.proto.common.v1.AnyValue;
import io.opentelemetry.proto.common.v1.KeyValue;
import io.opentelemetry.proto.metrics.v1.Gauge;
import io.opentelemetry.proto.metrics.v1.Metric;
import io.opentelemetry.proto.metrics.v1.NumberDataPoint;
import io.opentelemetry.proto.metrics.v1.ResourceMetrics;
import io.opentelemetry.proto.metrics.v1.ScopeMetrics;
import io.opentelemetry.proto.resource.v1.Resource;

/**
 * Java port of sdk/edgeclient's Reporter (Go). Reports a sampled "I called
 * this other system" signal to the local distviz agent so it can be drawn
 * as a dependency edge on the topology dashboard - deliberately not full
 * distributed tracing, just enough to establish that a dependency exists
 * and is still active.
 */
public class EdgeReporter {
    private static final String METRIC_NAME = "distviz.edge.calls";

    private final String agentEndpoint;
    private final String componentName;
    private final String componentType;
    private final Duration sampleEvery;
    private final HttpClient httpClient = HttpClient.newHttpClient();
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, Instant> lastSent = new ConcurrentHashMap<>();

    /** Component identity comes from the same COMPONENT_NAME/COMPONENT_TYPE
     * env vars the distviz agent itself uses; the agent endpoint defaults
     * to its local OTLP relay. */
    public EdgeReporter() {
        this(envOr("DISTVIZ_AGENT_ENDPOINT", "http://localhost:4318"),
                System.getenv("COMPONENT_NAME"),
                System.getenv("COMPONENT_TYPE"),
                Duration.ofSeconds(30));
    }

    public EdgeReporter(String agentEndpoint, String componentName, String componentType, Duration sampleEvery) {
        this.agentEndpoint = agentEndpoint;
        this.componentName = componentName == null ? "" : componentName;
        this.componentType = componentType == null ? "" : componentType;
        this.sampleEvery = sampleEvery;
    }

    /**
     * Records that this component talked to destination (e.g. a hostname),
     * subject to sampling. Safe to call on every request - most calls are
     * no-ops between sample windows.
     */
    public void report(String destination) {
        if (destination == null || destination.isEmpty() || componentName.isEmpty()) {
            return;
        }
        Instant messageTime = Instant.now();

        Instant last = lastSent.get(destination);
        if (last != null && Duration.between(last, messageTime).compareTo(sampleEvery) < 0) {
            return;
        }
        lastSent.put(destination, messageTime);

        // Fire and forget: an edge report is a best-effort signal, not
        // something the caller's own request should ever wait on or fail for.
        executor.submit(() -> send(destination, messageTime));
    }

    private void send(String destination, Instant messageTime) {
        try {
            byte[] body = buildRequest(destination, messageTime).toByteArray();
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(agentEndpoint + "/v1/metrics"))
                    .header("Content-Type", "application/x-protobuf")
                    .timeout(Duration.ofSeconds(3))
                    .POST(BodyPublishers.ofByteArray(body))
                    .build();
            httpClient.send(request, BodyHandlers.discarding());
        } catch (Exception e) {
            // best-effort; nothing to do if the local agent isn't reachable
        }
    }

    private ExportMetricsServiceRequest buildRequest(String destination, Instant messageTime) {
        long nanos = messageTime.getEpochSecond() * 1_000_000_000L + messageTime.getNano();

        NumberDataPoint dataPoint = NumberDataPoint.newBuilder()
                .addAttributes(stringAttr("destination", destination))
                .setTimeUnixNano(nanos)
                .setAsDouble(1)
                .build();

        Metric metric = Metric.newBuilder()
                .setName(METRIC_NAME)
                .setUnit("1")
                .setGauge(Gauge.newBuilder().addDataPoints(dataPoint))
                .build();

        Resource resource = Resource.newBuilder()
                .addAttributes(stringAttr("service.name", componentName))
                .addAttributes(stringAttr("component.type", componentType))
                .build();

        ResourceMetrics resourceMetrics = ResourceMetrics.newBuilder()
                .setResource(resource)
                .addScopeMetrics(ScopeMetrics.newBuilder().addMetrics(metric))
                .build();

        return ExportMetricsServiceRequest.newBuilder()
                .addResourceMetrics(resourceMetrics)
                .build();
    }

    private static KeyValue stringAttr(String key, String value) {
        return KeyValue.newBuilder()
                .setKey(key)
                .setValue(AnyValue.newBuilder().setStringValue(value))
                .build();
    }

    private static String envOr(String key, String fallback) {
        String v = System.getenv(key);
        return (v == null || v.isEmpty()) ? fallback : v;
    }
}
