// Command kafkaclient is a stand-in producer or consumer (chosen by MODE)
// used to generate Kafka traffic for the broker's JMX throughput metrics.
//
// It doesn't participate in dependency-edge detection: distviz now derives
// edges from real OpenTelemetry trace spans (see backend/internal/
// tracecorrelate), which relies on the server side of a call creating its
// own span linked via the propagated trace context. The Kafka broker is a
// third-party binary we don't instrument, so it never creates that span -
// there's no inbound side to correlate against, the same limitation a
// third-party server has under any auto-instrumentation-based tracing setup.
package main

import (
	"context"
	"log"
	"math/rand"
	"os"
	"time"

	"github.com/segmentio/kafka-go"
)

func main() {
	mode := envOr("MODE", "produce")
	brokers := envOr("KAFKA_BROKERS", "kafka:9092")
	topic := envOr("KAFKA_TOPIC", "load-test")

	switch mode {
	case "produce":
		produce(brokers, topic)
	case "consume":
		consume(brokers, topic)
	default:
		log.Fatalf("unknown MODE %q (want \"produce\" or \"consume\")", mode)
	}
}

func produce(brokers, topic string) {
	writer := &kafka.Writer{
		Addr:                   kafka.TCP(brokers),
		Topic:                  topic,
		AllowAutoTopicCreation: true,
	}
	defer writer.Close()

	log.Printf("producing to %s (topic=%s)", brokers, topic)
	for {
		msg := kafka.Message{Value: []byte(randomPayload())}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := writer.WriteMessages(ctx, msg)
		cancel()
		if err != nil {
			log.Printf("produce: %v", err)
		}
		time.Sleep(time.Duration(200+rand.Intn(600)) * time.Millisecond)
	}
}

func consume(brokers, topic string) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{brokers},
		Topic:   topic,
		GroupID: "distviz-demo-consumer",
	})
	defer reader.Close()

	log.Printf("consuming from %s (topic=%s)", brokers, topic)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, err := reader.ReadMessage(ctx)
		cancel()
		if err != nil {
			log.Printf("consume: %v", err)
			time.Sleep(2 * time.Second)
		}
	}
}

func randomPayload() string {
	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, 64)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
