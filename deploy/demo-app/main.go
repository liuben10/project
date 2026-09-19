// Command demoapp is a stand-in workload used to exercise distviz end to
// end: it serves a trivial HTTP endpoint and burns CPU/memory in bursts so
// the dashboard has something visibly changing to display.
package main

import (
	"context"
	"log"
	"math/rand"
	"net/http"
	"os"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func main() {
	go burnResources()

	if target := os.Getenv("CALL_TARGET"); target != "" {
		if err := setupTracing(); err != nil {
			log.Fatalf("setup tracing: %v", err)
		}
		go callTargetLoop(target)
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok\n"))
	})

	log.Println("demoapp listening on :9000")
	log.Fatal(http.ListenAndServe(":9000", nil))
}

// setupTracing wires up a real OpenTelemetry trace pipeline: each outbound
// call gets a span exported directly to the backend's OTLP traces endpoint,
// with the standard W3C traceparent header propagated to the callee so its
// own tracing (e.g. auto-instrumentation) links up as a child span - that
// parent/child relationship is what lets the backend infer a dependency
// edge, not any distviz-specific reporting from this process.
func setupTracing() error {
	backendEndpoint := envOr("BACKEND_ENDPOINT", "localhost:8080")
	componentName := envOr("COMPONENT_NAME", "unknown-component")

	exporter, err := otlptracehttp.New(context.Background(),
		otlptracehttp.WithEndpoint(backendEndpoint),
		otlptracehttp.WithInsecure(),
	)
	if err != nil {
		return err
	}

	res, err := resource.New(context.Background(), resource.WithAttributes(
		attribute.String("service.name", componentName),
	))
	if err != nil {
		return err
	}

	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{}) // W3C traceparent - easy to forget, and otelhttp is a no-op without it
	return nil
}

// callTargetLoop periodically calls another system's HTTP endpoint through
// an otelhttp-instrumented client, so each call gets a real OTel client
// span and propagates trace context to the callee - demoapp itself has no
// real reason to call anything, this exists purely to demonstrate the edge
// ends up on the topology dashboard once the callee's span links up as a child.
func callTargetLoop(target string) {
	client := &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)}
	for {
		resp, err := client.Get(target)
		if err != nil {
			log.Printf("call %s: %v", target, err)
		} else {
			resp.Body.Close()
		}
		time.Sleep(time.Duration(1000+rand.Intn(2000)) * time.Millisecond)
	}
}

// burnResources periodically spends CPU and holds onto memory for a random
// duration so container.cpu.usage and container.memory.usage move around.
func burnResources() {
	var ballast [][]byte
	for {
		busyFor := time.Duration(rand.Intn(2000)) * time.Millisecond
		deadline := time.Now().Add(busyFor)
		for time.Now().Before(deadline) {
			_ = sha256Like()
		}

		if rand.Intn(3) == 0 {
			ballast = append(ballast, make([]byte, 8*1024*1024)) // +8MB
		} else if len(ballast) > 0 {
			ballast = ballast[:len(ballast)-1]
		}

		time.Sleep(time.Duration(rand.Intn(1500)) * time.Millisecond)
	}
}

func sha256Like() uint64 {
	var x uint64 = 0xcbf29ce484222325
	for i := 0; i < 1_000_000; i++ {
		x ^= uint64(i)
		x *= 0x100000001b3
	}
	return x
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
