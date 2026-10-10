# LinkOS 启动、部署与维护

核心部署是一台机器、一个工作区、一个 Gateway 写入实例。网页和官方插件随 Go 程序内嵌发布；文件与聊天不依赖 Runner。生产机器无需安装 Node、pnpm 或 Go。

## 开发

准备 Node 24 或更新的稳定版本（推荐 24 LTS，已验证 26.4.0）、pnpm 9.15.5、Go 1.25 系列（本机也允许兼容的 Go 1.26）。启动器按最低版本检查，不会拒绝较新的稳定版本；不满足要求时会显示实际 Node 版本和可执行文件路径。在仓库根目录运行：

```sh
pnpm run setup:dev
pnpm dev
pnpm run doctor
pnpm run dev:status
```

`setup:dev` 按锁文件安装依赖、下载 Go 模块、构建 Gateway、初始化 `.local/linkos/linkos.json`。`dev` 不安装依赖：先检查项目身份与实例锁，复用服务，协调 Web 5173 / Gateway 8787 附近的空闲端口。实际地址以输出和 `.local/linkos/dev.json` 为准；Vite 使用 strictPort 和实际 Gateway 代理地址。

端口可由命令行或环境变量指定，优先级为命令行 → 环境变量 → 默认值。`--port` 是 `--web-port` 的别名，同时支持 `--web-port=5180` 写法：

```sh
pnpm dev --web-port 5180 --gateway-port 8790
```

PowerShell 环境变量写法：

```powershell
$env:LINKOS_WEB_PORT = "5180"
$env:LINKOS_GATEWAY_PORT = "8790"
pnpm dev
```

端口必须为 1–65535；被占用或被另一服务预留时，向后查找最多 100 个端口并输出实际选择，不终止占用进程。Gateway 的公开 URL、允许来源和 Vite 的 HTTP/WebSocket 代理随实际端口同步。已运行的同项目服务优先复用，再次执行不会为更换端口重启旧实例；端口参数在下次正常启动时生效。独立验收使用相同参数，默认端口仍为 15173 / 18887。

前端由 Vite HMR 更新。后端仅重启本次启动器创建的持久化实例，先编译候选程序，失败保留旧服务。Ctrl+C 只停止本次创建的服务。旧 Gateway 的健康接口缺少项目标识时，会尝试核实监听进程的仓库路径；无法核实的占用不终止。复用旧内存实例会提示存储状态，其数据不会被自动转换、清空或重启。

独立验收使用 `pnpm run setup:acceptance`、`pnpm run dev:acceptance`，数据在 `.local/acceptance`，优先使用 15173 / 18887。自动化测试可通过 `LINKOS_DEV_HOME` 指定独立目录，使用独立项目实例标识。

日志在对应 home 的 `logs/`。开发管理员口令文件为 `ADMIN-PASSCODE.txt`。使用 Playwright 时，把启动器输出的 Web 地址传给 `LINKOS_E2E_BASE_URL`，不要猜测端口。

## 便携程序

发布 Windows amd64 ZIP、Linux amd64/arm64 TAR.GZ。校验 `SHA256SUMS`，解压后先初始化：

```sh
linkos init --lan --host 192.168.1.20
linkos serve
```

Windows 使用 `linkos.exe`，之后可双击 `start.cmd`；Linux 使用 `./linkos` 或 `./start.sh`。命令可从任何工作目录执行。管理员口令在初始化输出指定的文件中。

默认 home：Windows `%LOCALAPPDATA%\LinkOS`；Linux `$XDG_DATA_HOME/linkos` 或 `~/.local/share/linkos`。自定义位置时，每次命令都带同一 `--home`，例如：

```sh
linkos init --lan --host linkos.lan --home /srv/linkos
linkos serve --home /srv/linkos
linkos status --home /srv/linkos
linkos logs --home /srv/linkos
linkos doctor --home /srv/linkos
linkos stop --home /srv/linkos
```

`init` 拒绝覆盖已有配置。不需要局域网访问时，`linkos init` 使用回环 HTTP；开放局域网使用 direct HTTPS。初始化会生成本地 CA、服务器证书和 `tls/TRUST.txt`；在每台客户端显式导入 `ca.crt`。私钥不能分发给客户端，程序不会修改系统信任或防火墙。固定 IP 或稳定域名必须与证书 SAN 匹配。

停止后用 `linkos tls renew --home ...` 续期，保留原 CA；CA 即将到期时需要显式生成新的信任根。自备证书可配置 `tlsCertFile` / `tlsKeyFile`。`healthcheck` 使用 home 内 CA 或操作系统信任根；自备证书应覆盖 localhost，或为其就绪探针配置独立检查方式。

## 配置契约

`linkos.json` 的 `schemaVersion` 为 1。优先级：命令行 → `LINKOS_*` 环境变量 → 配置文件 → 默认值。相对路径从配置文件目录解析；升级程序不覆盖 home。

| JSON 字段 | 环境变量 / CLI | 说明 |
| --- | --- | --- |
| environment | LINKOS_ENV | development / production |
| listen | LINKOS_LISTEN / --listen | 明确 IP:端口 |
| publicURL | LINKOS_PUBLIC_URL / --public-url | 对外 origin；发现、广播与页面统一使用 |
| dataDir | LINKOS_DATA_DIR / --data-dir | SQLite 和持久化状态 |
| uploadDir | LINKOS_UPLOAD_DIR / --upload-dir | CAS 与未完成分片；默认 home/data/uploads |
| tlsMode | LINKOS_TLS_MODE / --tls-mode | local、direct、proxy |
| tlsCertFile / tlsKeyFile | LINKOS_TLS_CERT_FILE / LINKOS_TLS_KEY_FILE | direct TLS 文件 |
| allowedOrigins | LINKOS_ALLOWED_ORIGINS / --allowed-origins | 逗号分隔的完整 origin |
| adminPasscode | LINKOS_ADMIN_PASSCODE / --admin-passcode | 生产至少 24 字符；默认随机生成 |
| pluginDir | LINKOS_PLUGIN_DIR / --plugin-dir | 可选外部插件目录 |
| pluginTrustedKeys | LINKOS_PLUGIN_TRUSTED_KEYS | 外部插件受信公钥，沿用既有编码格式 |
| webDir | LINKOS_WEB_DIR / --web-dir | 可选静态资源覆盖 |
| runnerURL / runnerAPIToken | LINKOS_RUNNER_URL / LINKOS_RUNNER_API_TOKEN | 可选 Runner endpoint 与执行 API 凭据 |
| discoveryPort | LINKOS_DISCOVERY_PORT / --discovery-port | UDP 发现端口 |

生产内嵌官方插件无需自行签名，使用原生应用窗口，版本跟随程序，只提供启停；生命周期状态保留。外部插件必须上传完整 `.linkos-plugin` 包并验证受信签名，首期仅支持 API 1.0、包内 HTML UI 和 deny 网络。外部应用经资源票据和版本/nonce/协议握手进入沙箱；制作与安装步骤见 [插件开发手册](plugin-development.md)。旧 manifest-only 记录标为待修复，启动扫描不覆盖已提交安装。

`/api/v1/healthz` 提供版本、提交和实例 ID；开发项目标识只给回环请求。`/api/v1/readyz` 检查数据库、文件存储和资源，Runner 关闭不影响就绪。上传路由的读取期限为 15 分钟，其他请求保留 30 秒期限；单分片上限仍为 64 MiB。

## Docker：拉取后启动

预构建镜像由 `.github/workflows/release.yml` 发布。尚未发布的版本不能拉取；本地源码构建见下一段。部署时在 `.env` 固定实际发布版本，正式部署建议固定 digest：

```text
LINKOS_IMAGE=ghcr.io/lee-zg/linkos:0.1.0
LINKOS_PORT=8787
```

```sh
docker compose pull
docker compose run --rm --no-deps gateway init --home /var/lib/linkos --lan --host 192.168.1.20
docker compose up -d --wait
docker compose logs -f gateway
```

首次初始化后配置、SQLite、上传和证书都在 `linkos-data` 卷中。导出客户端 CA：`docker compose cp gateway:/var/lib/linkos/tls/ca.crt ./linkos-ca.crt`。更改宿主发布端口时，初始化传入对应 `--public-url https://HOST:PORT`，内部监听仍为 8787。

源码构建：`docker compose -f docker-compose.yml -f docker-compose.source.yml build`，随后对相同文件组合执行初始化和 `up --wait`。镜像中使用与便携包相同的内嵌程序，不再需要 Web/Nginx 容器。保留的独立 Nginx 配置已经处理 64 MiB 分片、WebSocket、Range 和慢速上传。

域名入口使用 Compose >=2.24.4，设置 `LINKOS_DOMAIN=workspace.example.com`，首次初始化：

```sh
docker compose run --rm --no-deps gateway init --home /var/lib/linkos --tls-mode proxy --listen 0.0.0.0:8787 --public-url https://workspace.example.com
docker compose -f docker-compose.yml -f docker-compose.domain.yml up -d --wait
```

域名 overlay 让核心宿主端口仅绑定回环地址，Caddy 从容器私有网络访问核心，并管理公网域名证书。域名 DNS 与 80/443 可达性由部署环境提供。已初始化 direct TLS 的工作区需要先停止应用并显式调整配置。

## Runner 按需启用

首期支持在 Linux 或 WSL2 内运行的 Runner，隔离引擎必须在同一主机，生产必须 rootless Docker / Podman 和本地 Unix socket。远程 Docker/Podman 引擎因不能访问 Runner 临时工作目录而被拒绝。默认 Compose 不创建 Runner，不挂载特权宿主 socket。

```sh
go build -o linkos-runner ./services/runner
./linkos-runner doctor
```

通过诊断后，以专用普通用户运行。设置 `LINKOS_ENV=production`、`LINKOS_RUNNER_API_TOKEN`、`LINKOS_GATEWAY_URL`、`LINKOS_RUNNER_REGISTRATION_TOKEN`，必要时设置 `LINKOS_RUNNER_CA_FILE`。Gateway 的 `runnerAPIToken` 必须匹配执行 API token；注册凭据仅用于 Runner → Gateway 注册和心跳，生产不再作为执行 API token 回退。

Runner 默认监听 `127.0.0.1:9797`。跨机器连接需要 HTTPS、自备证书及受信 CA；Gateway 使用操作系统的信任根。WSL2 中 Runner 与引擎都在同一 Linux 环境内运行，Gateway 可通过本机回环转发访问。任务继续使用无网络、非特权、只读根文件系统和资源限额。

## 完整备份、恢复和升级

先停止开发启动器、前台 Gateway 或系统服务，等待在途写入完成。备份/恢复获取与服务相同的数据目录文件锁，在线写入时直接拒绝，不会边写边打包。

```sh
linkos backup --home /srv/linkos --output /backup/workspace.tar.gz
linkos init --home /srv/linkos-restored
linkos restore /backup/workspace.tar.gz --home /srv/linkos-restored
linkos serve --home /srv/linkos-restored
```

归档含 SQLite 一致性快照（包括 plugin_registry）、CAS 字节、未完成上传分片、有效配置与插件受信公钥、TLS 材料、外部插件当前/上一版本的不可变资源以及配置的旧插件源目录。包含口令与私钥，按私有数据保存。恢复先核验每项 SHA-256、SQLite integrity_check、格式和数据库版本；拒绝重复条目、路径穿越、符号链接及缺失文件。已有数据库需显式 `--replace`；原数据保留在 `.before-restore-*`，安装失败会还原。

跨目录/机器恢复将上传路径重定位到目标 data/uploads；身份、权限、聊天和文件内容随数据库恢复。包资源按目标 data/plugins 解析，旧配置插件源恢复到 data/plugin-source，避免覆盖包版本目录；受信公钥恢复后可继续验签和升级。网络、监听、域名及证书沿用目标初始化配置，恢复原管理员口令及其说明文件。源 TLS 材料在归档中保留，需要延续源 CA 时可在停止状态下显式取回；更换机器域名/IP 应使用目标证书。

容器备份：`docker compose stop gateway`，再 `docker compose run --rm --no-deps gateway backup --home /var/lib/linkos`，导出卷内生成的归档后再启动。恢复同样在核心停止时执行；不要使用 `down -v` 删除数据。

升级程序或镜像前先做完整备份，然后替换程序/固定镜像版本，再启动。程序发现持久化运行版本变化或需要迁移时，自动创建升级前完整备份；迁移在事务中完成，失败保留原数据。数据库比当前程序支持的版本更新时拒绝启动。降级只有在数据库版本兼容时才能切换旧程序；否则必须用升级前完整备份恢复数据和文件。

旧的 SQLite-only 备份 API 仍供历史工具使用，不构成完整工作区备份；新的 CLI backup/restore 使用完整归档。

## 系统服务与构建验收

显式 `linkos service install --home ...` 安装服务，不自动运行安装命令。Windows 需要管理员终端，安装后用 `Start-Service LinkOS`；Linux 安装用户 systemd unit，执行 `systemctl --user start linkos`。无人登录时运行需要管理员自行启用 linger。卸载：`linkos service uninstall --home ...`，停止服务并移除注册，保留数据。

安装路径必须稳定，更新前先停止服务。单实例数据锁防止用户双击、服务与另一份配置同时写同一个工作区。

```sh
pnpm test:launcher
node scripts/smoke-dev.mjs
pnpm release
node scripts/smoke-release.mjs /absolute/path/to/linkos
pnpm test:plugins
```

CI 覆盖 Windows/Linux 统一启动、重复启动、编译失败、Go 热重启、发布资源和 HTTPS/WS/大分片/慢速上传/Range/恢复冒烟，并在 Linux 跑 Compose 集成。插件验收覆盖桌面/移动端开发代理以及便携 HTTPS/受信签名发布；设置 LINKOS_PLUGIN_SMOKE_BINARY 指向发布程序即可独立执行。本机无 Docker 时，不能将配置检查或交叉编译称为容器或 Linux 实机验收。
