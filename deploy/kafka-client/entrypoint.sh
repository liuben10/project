#!/bin/sh
# Runs the distviz agent alongside the Kafka producer/consumer in the same
# container, so it reports both this container's cgroup usage and (via the
# process itself calling edgeclient.Reporter) a dependency edge to the
# Kafka broker.
set -eu

/usr/local/bin/distviz-agent &

exec /usr/local/bin/kafkaclient
