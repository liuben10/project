// Command kafkaclient is a stand-in producer or consumer (chosen by MODE)
// used to demonstrate distviz capturing edges for non-HTTP dependencies:
// producing to and consuming from Kafka both establish a real TCP
// connection to the broker, so both get reported the same way an HTTP call
// would be, just via edgeclient.Reporter directly instead of the HTTP
// Tripper wrapper.
package main

import (
	"context"
	"log"
	"math/rand"
	"os"
	"time"

	"github.com/segmentio/kafka-go"

	"distviz/sdk/edgeclient"
)

func main() {
	mode := envOr("MODE", "produce")
	brokers := envOr("KAFKA_BROKERS", "kafka:9092")
	topic := envOr("KAFKA_TOPIC", "load-test")
	// The logical component this process depends on - must match the
	// Kafka broker's own COMPONENT_NAME for the edge to point at a real node.
	brokerComponent := envOr("KAFKA_BROKER_COMPONENT", "kafka-broker")

	reporter := edgeclient.NewReporter()

	switch mode {
	case "produce":
		produce(brokers, topic, brokerComponent, reporter)
	case "consume":
		consume(brokers, topic, brokerComponent, reporter)
	default:
		log.Fatalf("unknown MODE %q (want \"produce\" or \"consume\")", mode)
	}
}

func produce(brokers, topic, brokerComponent string, reporter *edgeclient.Reporter) {
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
		} else {
			reporter.Report(brokerComponent)
		}
		time.Sleep(time.Duration(200+rand.Intn(600)) * time.Millisecond)
	}
}

func consume(brokers, topic, brokerComponent string, reporter *edgeclient.Reporter) {
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
			continue
		}
		reporter.Report(brokerComponent)
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
