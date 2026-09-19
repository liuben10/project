package com.distviz.demo;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

import org.springframework.stereotype.Component;

// Calls the inventory-service to check stock when an order is created. No
// distviz-specific code here: the OpenTelemetry Java auto-instrumentation
// agent (attached via -javaagent, see entrypoint.sh) automatically wraps
// java.net.http.HttpClient, creating a span for this call and propagating
// the W3C traceparent header - inventory-service's own auto-instrumentation
// picks that up as the parent of its inbound span, which is what lets the
// backend infer the java-api -> inventory-service edge.
@Component
public class InventoryClient {
    private final HttpClient httpClient = HttpClient.newHttpClient();
    private final String inventoryUrl;

    public InventoryClient() {
        String v = System.getenv("INVENTORY_SERVICE_URL");
        this.inventoryUrl = (v == null || v.isEmpty()) ? "http://inventory-service:8080/api/inventory" : v;
    }

    public void checkStock(long sku) {
        URI uri = URI.create(inventoryUrl + "/" + sku);
        try {
            HttpRequest request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(3)).GET().build();
            httpClient.send(request, HttpResponse.BodyHandlers.discarding());
        } catch (Exception e) {
            // best-effort demo call; an inventory-check failure shouldn't fail order creation
        }
    }
}
