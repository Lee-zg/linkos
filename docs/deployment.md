# LinkOS 部署手册

## 生产前置条件

- Linux 或 Windows 11 + Docker Desktop/WSL2 或 Podman machine（Runner 不会回退到宿主机执行）。
- Docker Compose v2、Node.js 20+、pnpm 9+（源码构建时）和 Go 1.25+（源码运行 Gateway 时）。
- 生产必须设置 `LINKOS_DATA_DIR`、`LINKOS_ADMIN_PASSCODE`、TLS 证书/私钥以及 `LINKOS_ALLOWED_ORIGINS`。未设置数据目录或管理员口令时 Gateway 拒绝启动。
- 生产插件必须设置 `LINKOS_PLUGIN_TRUSTED_KEYS`（逗号分隔的 Ed25519 公钥，支持 base64 或 hex）；Gateway 启动时会拒绝缺失配置。没有受信公钥时只允许开发态的 unsigned manifest。

## Compose 启动

```powershell
$env:LINKOS_ADMIN_PASSCODE = "replace-with-a-long-random-secret"
$env:LINKOS_ALLOWED_ORIGINS = "https://linkos.example.local"
$env:LINKOS_RUNNER_REGISTRATION_TOKEN = "replace-with-a-long-random-token"
docker compose up -d --build gateway web
```

Runner 使用独立的 rootless Docker/Podman engine。不要把宿主机 `/var/run/docker.sock` 挂进容器。设置远程 engine 的 `LINKOS_RUNNER_ENGINE_HOST`、`LINKOS_RUNNER_ENGINE_TLS_VERIFY` 和 `LINKOS_RUNNER_ENGINE_CERT_PATH` 后，再启动受 profile 保护的 Runner：

```powershell
docker compose --profile runner-protocol up -d --build runner
$env:LINKOS_RUNNER_URL = "https://runner.example.local:9797"
```

Gateway 的 `LINKOS_RUNNER_URL` 必须指向 Runner API；生产模式下没有 `LINKOS_RUNNER_REGISTRATION_TOKEN`（Runner API token）时任务请求返回 `AUTH_REQUIRED`。

管理员通过 `POST /api/v1/runners/registration-tokens` 创建 10 分钟单次注册令牌。受控部署流程调用注册接口后保存响应中的独立 credential，后续心跳使用 `Authorization: Runner <credential>` 或 `X-Runner-Credential`。`POST /api/v1/runners/:id/rotate-token`、`POST /api/v1/runners/:id/revoke` 和 `DELETE /api/v1/runners/:id` 分别用于轮换、撤销和删除。Gateway 不会让 Runner 自动向任意配置 URL 回传凭据。

## 健康检查与迁移

```text
GET /api/v1/healthz       Gateway
GET /healthz              Runner
GET /api/v1/metrics       Prometheus 文本指标
```

Gateway 启动时按 `schema_migrations` 顺序执行 SQLite 迁移。数据卷必须持久化 `/var/lib/linkos`，上传对象位于其 `uploads/objects` 目录。

## 备份与恢复

停止写入后执行：

```powershell
$env:LINKOS_DATA_DIR = "D:\linkos-data"
go run ./services/gateway backup > backup-manifest.json
go run ./services/gateway restore D:\linkos-data\backups\gateway-*.db
```

备份使用 SQLite `VACUUM INTO` 生成一致性快照，并输出大小、SHA-256 和 schema 版本。恢复前校验清单，恢复后检查 `/api/v1/healthz`、`/api/v1/discovery` 和最近事件重放。

## 升级与回滚

1. `docker compose pull` 或重新构建镜像，保留当前数据卷。
2. 先执行 `docker compose up -d gateway`，等待 healthcheck 通过，再更新 web/runner。
3. 迁移失败时保留日志和数据卷，使用上一版本镜像启动；不要删除 `gateway.db`。
4. 需要数据回滚时先停止 Gateway，使用已验证的备份执行 `gateway restore`，再启动并检查事件序号、上传会话和设备刷新令牌。

## 故障排查

- `RUNNER_UNAVAILABLE`：检查 Runner health、TLS、registration token、rootless engine 和 Gateway 的 `LINKOS_RUNNER_URL`；不会执行宿主机命令。
- `ACCESS_DENIED`/`AUTH_REQUIRED`：检查设备是否吊销、refresh token 是否轮换、成员角色和邀请码是否过期。
- 插件安装失败：检查 manifest API 版本、入口、权限、签名和 `LINKOS_PLUGIN_TRUSTED_KEYS`；健康检查失败时保持旧版本可回滚。
- 上传 507：检查 `LINKOS_CAS_MAX_DISK_BYTES` 和对象池淘汰日志；Range 下载要求资源仍在 CAS 中。

所有 HTTP 错误都包含 `error`、`message`、`traceId`，响应头同时返回 `X-Trace-ID`。日志和任务输出会脱敏 `TOKEN`、`PASSWORD`、`SECRET` 与 `API_KEY` 字段。
