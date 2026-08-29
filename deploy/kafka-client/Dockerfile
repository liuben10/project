# Build context is the repo root (needs the agent and sdk modules).
FROM golang:1.26 AS build-agent
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/agent .

FROM golang:1.26 AS build-client
WORKDIR /src
COPY sdk/ ./sdk/
WORKDIR /src/deploy/kafka-client
COPY deploy/kafka-client/go.mod deploy/kafka-client/go.sum ./
RUN go mod download
COPY deploy/kafka-client/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/kafkaclient .

FROM alpine:3.20
COPY --from=build-agent --chmod=0755 /out/agent /usr/local/bin/distviz-agent
COPY --from=build-client --chmod=0755 /out/kafkaclient /usr/local/bin/kafkaclient
COPY --chmod=0755 deploy/kafka-client/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
