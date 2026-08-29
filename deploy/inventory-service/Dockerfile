# Build context is the repo root (needs the agent module).
FROM maven:3.9-eclipse-temurin-21 AS build-app
WORKDIR /src
COPY deploy/inventory-service/pom.xml .
RUN mvn -B -q dependency:go-offline
COPY deploy/inventory-service/src ./src
RUN mvn -B -q -DskipTests package

FROM golang:1.26 AS build-agent
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/agent .

FROM eclipse-temurin:21-jre-alpine
COPY --from=build-app /src/target/*.jar /app/app.jar
COPY --from=build-agent --chmod=0755 /out/agent /usr/local/bin/distviz-agent
COPY --chmod=0755 deploy/inventory-service/entrypoint.sh /entrypoint.sh

ENV COMPONENT_TYPE=app-server
ENV PROM_SCRAPE_URL=http://localhost:8080/actuator/prometheus
ENV PROM_METRIC_SET=java-http

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
