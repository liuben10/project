#!/bin/bash
# Runs the distviz agent alongside the stock Kafka broker process in the
# same container, so it reports both this container's cgroup usage and (via
# the JMX Prometheus exporter javaagent already attached through KAFKA_OPTS)
# the broker's own throughput metrics.
set -eu

/usr/local/bin/distviz-agent &

# Scoped to this process tree only (not baked into the image's ENV) so that
# `docker exec`'d CLI tools like kafka-topics.sh don't also try to bind the
# JMX exporter's port and collide with the running broker's instance.
export KAFKA_OPTS="-javaagent:/opt/jmx-exporter/jmx_prometheus_javaagent.jar=7071:/opt/jmx-exporter/kafka-metrics.yml"

# Hand off to the base apache/kafka image's normal startup sequence so Kafka
# itself becomes the container's foreground process.
exec /__cacert_entrypoint.sh /etc/kafka/docker/run
