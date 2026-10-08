FROM node:24-bookworm-slim AS web
ARG VERSION=dev
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.5 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages packages
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
RUN pnpm --filter @linkos/web build
COPY plugins plugins
COPY scripts/stage-plugins.mjs scripts/stage-plugins.mjs
RUN node scripts/stage-plugins.mjs plugins /out/plugins "$VERSION"

FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.work go.work.sum ./
COPY services/gateway services/gateway
COPY services/runner/go.mod services/runner/go.sum services/runner/
COPY --from=web /out/plugins services/gateway/bundle/plugins
COPY --from=web /src/apps/web/dist services/gateway/bundle/web
ARG VERSION=dev
ARG COMMIT=unknown
RUN CGO_ENABLED=0 go build -tags release -trimpath -ldflags "-s -w -X main.buildVersion=${VERSION} -X main.buildCommit=${COMMIT}" -o /out/linkos ./services/gateway

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home linkos && mkdir /var/lib/linkos && chown linkos:linkos /var/lib/linkos
COPY --from=build /out/linkos /usr/local/bin/linkos
USER 10001:10001
VOLUME /var/lib/linkos
EXPOSE 8787
ENTRYPOINT ["linkos"]
CMD ["serve", "--home", "/var/lib/linkos"]
