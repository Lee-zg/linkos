# ADR-006：MVP 前置的工作区会话鉴权边界

- 状态：开发态已实现，生产方案待定
- 日期：2026-08-31
- 关联任务：Phase 1 第 1-2 周、身份与发现

## 背景

Gateway 原先使用固定 `dev-token`，消息、任务、上传和 WebSocket 路由在没有凭据时也可访问。这会让 UI 的在线状态被误解为服务端已完成身份和权限保护，也无法为后续 RBAC、审计和设备撤销提供入口。

## 决策

当前先实现开发态会话边界：

- `POST /api/v1/sessions` 为公开 bootstrap 入口，返回 32 字节随机生成的短期 Bearer token，默认有效期 1 小时。
- 受保护 HTTP 路由必须携带 `Authorization: Bearer <token>`。
- 浏览器 WebSocket 受限于握手 API，PoC 通过 `access_token` 查询参数传递同一 token；生产实现应改为 HttpOnly 同源 cookie 或受约束的 WebSocket 子协议，避免 token 出现在 URL 日志中。
- 当前会话绑定固定 `demo` 工作区和 `member` 角色；不会把角色字段当作最终 RBAC 授权结论。
- `/api/v1/healthz`、`/api/v1/discovery` 和会话 bootstrap 保持公开；工作区快照、资源、上传、消息、任务、插件和 WebSocket 均经过统一中间件。
- token 过期后从内存会话表删除。服务重启会使所有开发态会话失效，这是有意的 PoC 行为。

## 未决事项

最终 MVP 需要补充：邀请码/一次性二维码、设备公钥和撤销、access/refresh token 轮换、TLS/mTLS、角色权限矩阵、审计记录和持久化会话。完成这些项前不得把当前 bootstrap 入口暴露到不可信网络。

## 验收

- 无 token、错误 token、过期 token 和工作区不匹配 token 均返回 `401 AUTH_REQUIRED`。
- 有效 token 可访问工作区资源并建立 WebSocket。
- 前端在首次受保护请求前自动 bootstrap 会话，并将 token 注入 HTTP/WS 请求。
- 会话 token 不写入业务日志和 UI 文本；生产方案评审前禁止复制到 URL 分享或诊断包。

