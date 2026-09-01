# LinkOS 架构说明

## 当前切片

```text
Browser (React/Vite)
       |
       | HTTPS + WebSocket
       v
Gateway :8787  ----  Runner :9797 (安全协议 stub)
       |
       +-- protocol events + bounded replay
       +-- demo resources
       +-- upload session/part PoC
       +-- job state simulation
```

当前 Gateway 仍为开发模式：使用内存事件历史、内存短期会话、demo 资源和本地临时目录上传，不持久化用户/权限/业务元数据。已完成事件序号、1,000 条有界历史、`last_event_seq` 补发和超窗口快照提示的 PoC；已完成上传会话、分片 SHA-256 校验、乱序/断点恢复和完整文件校验的 PoC；已接入开发态随机 Bearer 会话和工作区路由统一鉴权。下一步接入 SQLite 元数据、设备身份/RBAC、内容寻址文件存储、Range 下载和事件快照恢复；Runner 在 Linux 上使用 rootless container/WASI 进行隔离执行。

上传 PoC 路径：

```text
POST  /api/v1/uploads
GET   /api/v1/uploads/:id
PATCH /api/v1/uploads/:id/parts/:partNo
POST  /api/v1/uploads/:id/complete
```

分片编号从 `0` 开始，分片内容通过请求体发送，SHA-256 通过 `X-Part-SHA256` 请求头提交。该接口当前没有身份校验、配额、Range 下载和跨进程恢复能力，不应直接用于生产部署。

## 事件约束

- `eventId` 幂等。
- `seq` 在工作区内单调递增。
- 大对象只发送资源引用，不塞进 WebSocket payload。
- 慢客户端使用有界队列，超过预算则降级为快照。
