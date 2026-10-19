# LinkOS CLI 与项目配置

## 一键开发

源码需要 Node 24 或更新的稳定版本（推荐 24 LTS）、pnpm 9.15.5、Go 1.25/1.26：

```sh
pnpm dev
pnpm doctor
pnpm dev:status
```

首次 `dev` 自动准备冻结锁文件依赖和持久化工作区；后续按依赖指纹复用准备结果。准备失败不写成功标记。缺少工具链时显示修复建议，不自动安装系统工具链。可单独执行 `pnpm setup:dev`。源代码 CLI 的 Node 默认沿用当前启动它的 Node；显式配置、环境变量和参数仍优先。

## 安装全局命令

```sh
pnpm linkos cli install
```

此显式命令会先构建当前平台的完整便携程序，再安装用户级 CLI。Windows 安装在 `%LOCALAPPDATA%/Programs/LinkOS` 并更新用户 PATH；Linux 的启动入口为 `~/.local/bin/linkos`，版本程序位于 `~/.local/share/linkos-cli`。Linux 终端尚未包含该目录时，按输出添加 PATH。Windows PATH 变更后打开新终端。

版本程序按摘要存入独立目录，更新切换启动入口，保留旧版本，不覆盖正在运行的程序。更新源码后再次执行上述命令更新 CLI。已下载的便携程序也可执行 `linkos cli install`，无需开发工具链。

```sh
linkos dev
linkos dev status
linkos dev logs --follow
linkos dev stop
linkos doctor --json
linkos cli uninstall
```

`dev stop` 仅通过带随机凭据的回环控制器停止该启动器管理的服务，复用实例不回收。卸载仅撤销全局入口和对应用户 PATH，保留版本程序与工作区数据。不会覆盖或删除无关同名命令、被修改的启动入口。`--install-dir DIR` 可用于隔离安装，此时不会修改 PATH。

## 项目配置

根目录 `linkos.config.json` 只含工具链、开发和打包设置，提供 JSON Schema 补全。管理员口令、CA 私钥、数据库和插件数据保存在工作区；生产运行配置仍为 `home/linkos.json`，不会随源码打包。

```sh
linkos config show
linkos config get dev.port
linkos config set dev.port auto
linkos config set dev.port 8443
linkos config set dev.lanIP 192.168.1.20
linkos config set dev.publicHost workspace.example.lan
linkos config validate
linkos --project D:/GitProject/GitHub/linkos dev
linkos pack --project-config D:/settings/linkos.config.json --target current
```

从项目子目录自动向上定位源码，其他目录使用 `--project DIR`；`--project-config FILE` 指定项目配置，原 `--config FILE` 仍指定生产运行配置。配置文件中的相对路径以该文件所在目录解析；单纯的 `node`、`go` 命令名通过 PATH 查找，带斜线的相对工具路径也以配置文件为基准。

优先级为参数 → 环境变量 → 项目配置 → 默认值。`config show` 展示解析后的项目设置，`config get` 查看文件设置与默认值，`config set` 校验后原子保存；修改不会自动重启现有服务。

| 配置 | 环境变量 | 参数 |
| --- | --- | --- |
| `dev.home` | `LINKOS_DEV_HOME` | `--home` |
| `dev.port` | `LINKOS_DEV_PORT` | `--port` |
| `dev.vitePort` | `LINKOS_VITE_PORT` | `--vite-port` |
| `dev.host` | `LINKOS_WEB_HOST` | `--host` |
| `dev.lanIP` | `LINKOS_LAN_IP` | `--lan-ip` |
| `dev.publicHost` | `LINKOS_PUBLIC_HOST` | `--public-host` |
| `dev.https` | `LINKOS_DEV_HTTPS` | `--https true/false` |
| `tools.node` / `tools.go` | `LINKOS_NODE` / `LINKOS_GO` | `--node` / `--go` |
| `pack.outDir` | `LINKOS_RELEASE_DIR` | `--out-dir` |
| `pack.targets` | `LINKOS_TARGET`（逗号分隔） | `--target` |

端口支持 `auto`、`0` 和 1–65535；自动入口优先沿用上次浏览器入口，其次 8443，再由系统分配。数字端口作为首选，占用时协调空闲端口，不停止占用者。旧 `--web-port`、`--gateway-port` 及对应环境变量保留迁移提示；两个旧值不同时改用 `--port` 明确唯一入口。

## 网络与诊断

Gateway 提供唯一 HTTPS 网页、API、业务 WebSocket 和插件入口；Vite 为内部回环 HTTP，HMR 通过 Gateway 专用路径连接。访问地址以终端和 `dev status` 为准。

自动筛选实际 IPv4 网卡；可指定已分配的局域网或 VPN IP。`publicHost` 支持已有 DNS 主机名，不创建 DNS 记录。客户端首次信任 `home/dev-web/tls/ca.crt`，说明见同目录 `TRUST.txt`；程序不修改系统信任或防火墙。保留旧开发 CA，每次新启动按当前地址签发叶证书；更换网络或配置在下一次正常启动生效。

已有服务优先复用。旧 Gateway 仍运行时保留旧 Web 拓扑，不自动迁移或重启内存实例；完全正常停止后的新启动才切换 Gateway 入口。前端保留 HMR，后端候选编译成功后才重启受管理的持久化实例；源码 CLI 编译失败时可沿用最近成功构建的 CLI 做诊断和复用。

```sh
linkos dev --host 127.0.0.1
linkos dev --host 127.0.0.1 --https false
linkos dev --lan-ip 192.168.1.20
linkos dev --acceptance
linkos doctor --runtime --home /srv/linkos
```

独立验收默认 `.local/acceptance`、回环 HTTP 和独立实例标识；自动化使用临时 `LINKOS_DEV_HOME`。局域网验收需显式启用 HTTPS。诊断默认只读，报告工具路径、配置、依赖、网卡、登记实例、页面、API 和 HMR；离线登记显示警告，不自动启动服务。业务 WebSocket 的完整鉴权连接由登录后的浏览器验收覆盖。Runner 可选，未启用不影响核心服务。

## 正式打包

```sh
linkos pack --version 0.2.0
linkos pack --version 0.2.0 --target current
linkos pack --version 0.2.0 --target windows/amd64,linux/amd64,linux/arm64
pnpm release --version 0.2.0
```

打包校验工具和依赖，执行 TypeScript 检查、网页构建、官方插件暂存和 Go 发布编译。项目锁防止并行覆盖内嵌暂存目录；全部目标及压缩包成功后再发布，发布过程失败还原旧产物。

输出程序、启动脚本、`VERSION.json`、ZIP/TAR.GZ、`manifest.json` 和 `SHA256SUMS`。仅嵌入网页和官方插件，不包含开发配置、数据库、口令及私钥。部署机器无需 Node、Go、Docker。此命令不上传制品或发布镜像。正式部署的初始化、证书、备份恢复和服务管理见 [部署手册](deployment.md)。
