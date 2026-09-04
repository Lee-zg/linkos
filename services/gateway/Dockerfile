FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /out/linkos-gateway .
FROM alpine:3.20
COPY --from=build /out/linkos-gateway /usr/local/bin/linkos-gateway
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/linkos-gateway"]
