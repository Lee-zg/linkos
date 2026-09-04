FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN go build -o /out/linkos-runner .
FROM alpine:3.20
RUN apk add --no-cache docker-cli ca-certificates
RUN addgroup -S linkos && adduser -S -G linkos -h /home/linkos linkos
COPY --from=build /out/linkos-runner /usr/local/bin/linkos-runner
USER linkos
EXPOSE 9797
ENTRYPOINT ["/usr/local/bin/linkos-runner"]
