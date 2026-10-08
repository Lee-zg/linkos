# LinkOS

局域网优先的网页办公协同工作台。文件传输、实时聊天、代码查看与运行都在一个工作区中完成，功能以插件形式扩展。

> 当前版本为 LinkOS MVP（v0.1.0）：工作台 UI 已接入真实聊天、代码版本、资源元数据、设备/refresh 身份、RBAC、插件生命周期和 Runner-backed 任务 API。Runner 仅允许隔离容器执行，生产部署要求 rootless Docker/Podman、TLS 和持久化数据目录。

## 目标

- 纯网页客户端，不安装桌面客户端即可查看、聊天和协作。
- 局域网内低延迟传输与实时事件，支持后续断线补发和大文件分片。
- 核心只提供身份、资源、事件和插件宿主；业务能力独立成插件。
- 对编译/运行采用独立 Runner，默认无网络、非特权、限额和可审计。

## 快速开始

### 前置条件

- Node.js 24 或更新的稳定版本（推荐 24 LTS，已验证 26.4.0）与 pnpm 9.15.5
- Go 1.25 系列（兼容 Go 1.26）

### 一次准备，一个命令启动

```bash
pnpm run setup:dev
pnpm dev
pnpm run doctor
pnpm run dev:status
```

启动器管理 Gateway 与 Vite，保留 HMR；先检查已有项目服务并复用，端口冲突时协调空闲端口。访问地址以终端输出为准。数据库、文件和日志保存在 `.local/linkos`，后端编译失败时保留旧实例。

需要自定义端口时执行 `pnpm dev --web-port 5180 --gateway-port 8790`（`--port` 也可指定 Web 端口），或设置 `LINKOS_WEB_PORT` / `LINKOS_GATEWAY_PORT` 环境变量。指定端口被占用时自动尝试后续空闲端口，代理使用实际 Gateway 地址；已有项目服务优先复用。

生产 Compose、TLS、Runner engine、备份恢复和回滚流程见 [`docs/deployment.md`](docs/deployment.md)。

### 便携部署

```bash
linkos init --lan --host 192.168.1.20
linkos serve
```

便携包内嵌网页和官方插件，部署机器无需 Node、Go 或 Docker。Windows 后续可双击 `start.cmd`，Linux 可执行 `./start.sh`。客户端需显式信任初始化生成的 CA。`pnpm release` 构建 Windows amd64 和 Linux amd64/arm64 发布包、清单与校验值。

### 运行检查

```bash
pnpm --filter @linkos/web typecheck
pnpm --filter @linkos/web build
go test ./services/gateway/... ./services/runner/...
```

## 仓库结构

```text
apps/web                 React + Vite 工作台
services/gateway         单地址网页、Go API、持久化与运行管理
services/runner          可选的同主机 rootless 隔离任务执行
packages/protocol        HTTP/WebSocket/资源/任务 schema
packages/plugin-sdk      插件开发类型与权限模型
plugins/*                官方插件 manifest
docs/                    架构、ADR 和开发计划
```

## 开发原则

1. 先更新 `packages/protocol` 的 schema，再写跨模块实现。
2. 插件只通过 capability API 访问资源，不读取核心数据库表。
3. 任何执行能力必须先补充威胁模型、隔离策略和负面测试。
4. 长列表、代码和日志必须虚拟化或分页，禁止无界加载。
5. 功能完成必须具备成功、空、离线、权限不足和错误状态。

## 安全状态

统一开发启动器默认持久化，保留既有内存实例的复用能力。生产初始化生成管理员口令，局域网模式启用 HTTPS；官方插件随程序内嵌，外部插件仍需受信签名。Runner 按需配置，生产仅允许同主机 rootless 引擎。完整备份恢复、配置优先级和升级兼容条件见部署手册。

产品 PRD 与落地方案见：`docs/prd/linkos-lan-collaboration-prd.md`。

## 许可

MIT License。
