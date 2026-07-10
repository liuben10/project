#!/bin/sh
# Runs the distviz agent and the demo workload as two processes inside the
# same container, mirroring how the agent is meant to be deployed: sharing
# the app's container (and therefore its cgroup) so it reports that
# container's real resource usage.
set -u

/usr/local/bin/agent &
AGENT_PID=$!

/usr/local/bin/demoapp &
APP_PID=$!

cleanup() {
	kill -TERM "$AGENT_PID" "$APP_PID" 2>/dev/null
	wait
	exit 0
}
trap cleanup TERM INT

wait "$APP_PID"
kill -TERM "$AGENT_PID" 2>/dev/null
wait "$AGENT_PID"
