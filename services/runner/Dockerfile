FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN go build -o /out/linkos-runner .
FROM alpine:3.20
COPY --from=build /out/linkos-runner /usr/local/bin/linkos-runner
EXPOSE 9797
ENTRYPOINT ["/usr/local/bin/linkos-runner"]
