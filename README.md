# LinkOS

局域网优先的网页办公协同工作台。文件传输、实时聊天、代码查看与运行都在一个工作区中完成，功能以插件形式扩展。

> 当前版本是可运行的技术验证切片（v0.1.0）：包含工作台 UI、Gateway 发现/快照/WebSocket/任务模拟 API、插件 manifest 和 Runner 协议骨架。任意命令执行默认关闭，待沙箱实现与安全评审完成后再开启。

## 目标

- 纯网页客户端，不安装桌面客户端即可查看、聊天和协作。
- 局域网内低延迟传输与实时事件，支持后续断线补发和大文件分片。
- 核心只提供身份、资源、事件和插件宿主；业务能力独立成插件。
- 对编译/运行采用独立 Runner，默认无网络、非特权、限额和可审计。

## 快速开始

### 前置条件

- Node.js 20+ 与 pnpm 9+
- Go 1.23+

### 启动 Gateway

```bash
cd services/gateway
go run .
```

Gateway 默认监听 `http://127.0.0.1:8787`。

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

本地开发 API 默认开启 CORS 和 demo 数据，不适用于生产部署。生产模式必须配置 TLS、设备密钥、RBAC、审计持久化、真实内容寻址存储和隔离 Runner。

产品 PRD 与落地方案见：`docs/prd/linkos-lan-collaboration-prd.md`。

## 许可

MIT License。
