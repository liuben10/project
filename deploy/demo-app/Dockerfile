# Build context is the repo root so this image can pull in both the agent
# module and the demo workload module and package them together, since the
# agent is meant to run inside the same container as the application.
FROM golang:1.26 AS build-agent
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/agent .

FROM golang:1.26 AS build-demoapp
WORKDIR /src
COPY sdk/ ./sdk/
WORKDIR /src/deploy/demo-app
COPY deploy/demo-app/go.mod deploy/demo-app/go.sum ./
RUN go mod download
COPY deploy/demo-app/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/demoapp .

FROM alpine:3.20
COPY --from=build-agent /out/agent /usr/local/bin/agent
COPY --from=build-demoapp /out/demoapp /usr/local/bin/demoapp
COPY deploy/demo-app/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 9000
ENTRYPOINT ["/entrypoint.sh"]
