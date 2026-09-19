#!/bin/sh
# Runs the distviz agent alongside the JVM in the same container (reporting
# cgroup usage and, via Actuator, HTTP request-rate metrics), plus the real
# OpenTelemetry Java auto-instrumentation agent, which creates spans for
# inbound requests with zero code changes and exports them straight to the
# backend's OTLP traces endpoint - that's how distviz now detects
# dependency edges (see backend/internal/tracecorrelate).
set -eu

/usr/local/bin/distviz-agent &

export OTEL_SERVICE_NAME="${COMPONENT_NAME}"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://${BACKEND_ENDPOINT}"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none
export OTEL_LOGS_EXPORTER=none

exec java -javaagent:/opt/otel/opentelemetry-javaagent.jar -jar /app/app.jar
