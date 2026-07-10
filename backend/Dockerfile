FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/backend .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/backend /backend
EXPOSE 8080
VOLUME ["/data"]
ENV DB_PATH=/data/distviz.db
ENTRYPOINT ["/backend"]
