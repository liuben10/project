package com.distviz.inventory;

import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

// A stand-in downstream service - java-api calls this to check stock when
// creating an order, giving distviz a real second Java hop to draw an edge
// for (java-api -> inventory-service), on top of the checkout-service ->
// java-api edge that already exists.
@RestController
public class InventoryController {

    @GetMapping("/api/inventory/{sku}")
    public Map<String, Object> checkStock(@PathVariable long sku) throws InterruptedException {
        Thread.sleep(ThreadLocalRandom.current().nextInt(5, 80));
        return Map.of(
                "sku", sku,
                "inStock", ThreadLocalRandom.current().nextBoolean(),
                "quantity", ThreadLocalRandom.current().nextInt(0, 200));
    }
}
