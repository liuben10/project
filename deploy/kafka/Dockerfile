# Build context is the repo root (needs the agent module).
FROM golang:1.26 AS build-agent
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/agent .

FROM curlimages/curl:8.11.0 AS fetch-jmx-exporter
ARG JMX_EXPORTER_VERSION=1.6.0
RUN curl -fsSL -o /tmp/jmx_prometheus_javaagent.jar \
    "https://github.com/prometheus/jmx_exporter/releases/download/v${JMX_EXPORTER_VERSION}/jmx_prometheus_javaagent-${JMX_EXPORTER_VERSION}.jar"

FROM apache/kafka:latest
COPY --from=build-agent --chmod=0755 /out/agent /usr/local/bin/distviz-agent
COPY --from=fetch-jmx-exporter /tmp/jmx_prometheus_javaagent.jar /opt/jmx-exporter/jmx_prometheus_javaagent.jar
COPY deploy/kafka/jmx-kafka-metrics.yml /opt/jmx-exporter/kafka-metrics.yml
COPY --chmod=0755 deploy/kafka/entrypoint.sh /distviz-entrypoint.sh

ENV COMPONENT_TYPE=message-queue
ENV PROM_SCRAPE_URL=http://localhost:7071/metrics
ENV PROM_METRIC_SET=kafka

EXPOSE 9092 29092 7071
ENTRYPOINT ["/distviz-entrypoint.sh"]
