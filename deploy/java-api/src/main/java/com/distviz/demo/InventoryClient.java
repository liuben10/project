package com.distviz.demo;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

import org.springframework.stereotype.Component;

import com.distviz.demo.edge.EdgeReporter;

// Calls the inventory-service to check stock when an order is created,
// giving distviz a second real dependency edge to draw
// (java-api -> inventory-service) alongside checkout-service -> java-api.
@Component
public class InventoryClient {
    private final HttpClient httpClient = HttpClient.newHttpClient();
    private final EdgeReporter edgeReporter = new EdgeReporter();
    private final String inventoryUrl;

    public InventoryClient() {
        String v = System.getenv("INVENTORY_SERVICE_URL");
        this.inventoryUrl = (v == null || v.isEmpty()) ? "http://inventory-service:8080/api/inventory" : v;
    }

    public void checkStock(long sku) {
        URI uri = URI.create(inventoryUrl + "/" + sku);
        edgeReporter.report(uri.getHost());
        try {
            HttpRequest request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(3)).GET().build();
            httpClient.send(request, HttpResponse.BodyHandlers.discarding());
        } catch (Exception e) {
            // best-effort demo call; an inventory-check failure shouldn't fail order creation
        }
    }
}
