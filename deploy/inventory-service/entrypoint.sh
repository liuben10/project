#!/bin/sh
# Runs the distviz agent alongside the JVM in the same container, so it can
# report both this container's cgroup usage and (by scraping the app's own
# Actuator Prometheus endpoint) real HTTP request-rate metrics.
set -eu

/usr/local/bin/distviz-agent &

exec java -jar /app/app.jar
