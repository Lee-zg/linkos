# LinkOS 架构说明

## 当前切片

```text
Browser (React/Vite)
       |
       | HTTPS + WebSocket
       v
Gateway :8787  ----  Runner :9797 (安全协议 stub)
       |
       +-- protocol events
       +-- demo resources
       +-- job state simulation
```

当前 Gateway 为开发模式：使用内存事件广播和 demo 资源，不持久化用户数据。下一步将把事件序号、SQLite 元数据、内容寻址文件存储和上传分片接口接入；Runner 在 Linux 上使用 rootless container/WASI 进行隔离执行。

## 事件约束

- `eventId` 幂等。
- `seq` 在工作区内单调递增。
- 大对象只发送资源引用，不塞进 WebSocket payload。
- 慢客户端使用有界队列，超过预算则降级为快照。

