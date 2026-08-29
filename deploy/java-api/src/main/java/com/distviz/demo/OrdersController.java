package com.distviz.demo;

import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

// A stand-in workload: simulated latency and an occasional failure so the
// request-rate/latency metrics scraped via Actuator have something realistic
// to show, rather than a flat line.
@RestController
public class OrdersController {

    private final InventoryClient inventoryClient;

    public OrdersController(InventoryClient inventoryClient) {
        this.inventoryClient = inventoryClient;
    }

    @GetMapping("/api/orders/{id}")
    public ResponseEntity<?> getOrder(@PathVariable long id) throws InterruptedException {
        simulateWork();
        if (ThreadLocalRandom.current().nextInt(20) == 0) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("error", "simulated failure"));
        }
        return ResponseEntity.ok(Map.of(
                "id", id,
                "status", "confirmed",
                "total", ThreadLocalRandom.current().nextDouble(5, 500)));
    }

    @PostMapping("/api/orders")
    public ResponseEntity<?> createOrder() throws InterruptedException {
        simulateWork();
        long id = ThreadLocalRandom.current().nextLong(1_000_000);
        inventoryClient.checkStock(id % 1000);
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("id", id, "status", "created"));
    }

    private void simulateWork() throws InterruptedException {
        Thread.sleep(ThreadLocalRandom.current().nextInt(10, 150));
    }
}
