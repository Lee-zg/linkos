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

- Node.js 20+ 与 pnpm 9+
- Go 1.25+

### 启动 Gateway

```bash
cd services/gateway
go run .
```

Gateway 默认监听 `http://127.0.0.1:8787`。

生产 Compose、TLS、Runner engine、备份恢复和回滚流程见 [`docs/deployment.md`](docs/deployment.md)。

### 启动 Web

```bash
pnpm install
pnpm --filter @linkos/web dev
```

打开 `http://127.0.0.1:5173`。Vite 会将 `/api` 代理到 Gateway。

### 运行检查

```bash
pnpm --filter @linkos/web typecheck
pnpm --filter @linkos/web build
go test ./services/gateway/... ./services/runner/...
```

## 仓库结构

```text
apps/web                 React + Vite 工作台
services/gateway         Go API、WebSocket 事件和任务模拟
services/runner          Runner 注册与任务协议骨架
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

本地开发 API 默认使用 demo 数据和内存后端。生产模式必须配置 `LINKOS_DATA_DIR`、TLS、设备密钥、RBAC、审计持久化、内容寻址存储、插件受信公钥和隔离 Runner。

产品 PRD 与落地方案见：`docs/prd/linkos-lan-collaboration-prd.md`。

## 许可

MIT License。
