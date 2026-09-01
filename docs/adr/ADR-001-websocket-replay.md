# ADR-001：WebSocket 事件序号、补发窗口与快照恢复

- 状态：已接受（Phase 0 PoC）
- 日期：2026-08-31
- 关联任务：P0-01、S0-02、S0-03

## 背景

LinkOS 的聊天、任务日志和状态更新通过 WebSocket 传递。浏览器可能因为网络切换、网关重启或页面休眠而短暂断线；仅依靠重新建立连接会丢失事件，也会让本地消息和广播消息重复显示。PRD 要求事件在工作区内拥有单调递增的 `seq`，客户端重连时携带 `last_event_seq`，服务端能够补发缺失事件，超出保留窗口时返回快照。

当前 Gateway 是开发模式，业务数据和事件均在内存中。本 ADR 先固化协议和存储接口，使用有界内存实现完成行为验证；SQLite/其他持久化实现留到后续任务，不把 PoC 的可靠性扩大解释为生产能力。

## 决策

### 1. 事件封装

事件使用 `packages/protocol` 的 `DomainEvent` 结构：

```json
{
  "v": 1,
  "type": "chat.message.created",
  "eventId": "evt_42",
  "seq": 42,
  "ts": "2026-08-31T10:12:33.120Z",
  "workspaceId": "ws_demo",
  "actorId": "gateway",
  "payload": {"clientMsgId": "cm_1"}
}
```

- `eventId` 全局唯一，用于消费者幂等。
- `seq` 在单个工作区内严格递增；只在事件成功进入存储后分配。
- 大对象只通过资源引用传递，不进入事件 payload。
- 未知事件类型必须忽略并记录指标，不能导致连接关闭。

### 2. 重连与补发

1. 客户端连接 `/api/v1/ws?workspace=<id>&last_event_seq=<n>`。
2. Gateway 注册客户端后发送 `workspace.ready`，其中的 `seq` 表示当前已知序号。
3. 如果 `n` 仍在历史保留窗口内，Gateway 按 `seq` 升序补发 `n` 之后的事件。
4. 如果 `n` 早于保留窗口，Gateway 发送 `workspace.snapshot.required`，客户端随后获取 `GET /api/v1/workspaces/:id/snapshot`；快照完成后以快照序号作为新的游标。
5. 连接建立之后产生的新事件按实时队列发送。队列有界，慢客户端超出预算时断开或降级为快照通知，禁止无限增长。

PoC 阶段先实现第 1、2、3 和实时队列；快照通知字段和持久化恢复接口先留在协议/测试中，下一步接入 SQLite 时完成第 4 项。

### 3. 存储接口

Gateway 将事件广播与存储解耦，抽象出以下行为：

```text
Append(event) -> persisted event
Since(seq) -> ordered events after seq, plus retention status
CurrentSeq() -> latest sequence
```

当前实现使用有界内存 ring buffer，默认保留最近 1,000 条事件。接口调用方不能直接修改历史事件；事件只追加不更新。未来 SQLite 实现必须保持相同语义，并以事务保证序号分配与写入原子化。

### 4. 去重边界

- 服务端按 `eventId` 保证广播事件只生成一次。
- 客户端按 `eventId` 去重，并对带 `clientMsgId` 的消息再做一次客户端幂等保护。
- HTTP 写入接口必须接受重复 `clientMsgId`，返回原消息结果，而不是再次创建消息。
- 去重集合必须有界或带 TTL，不能随在线时长无限增长。

## 未决事项

- 事件保留时间和条数最终采用“7 天或 1,000,000 条取先到者”，需要在 SQLite 方案中加入清理任务。
- 超窗口恢复使用单次快照还是分页快照，待大工作区压测后确定。
- 多 Gateway 部署时由数据库或 NATS JetStream 提供全局序号，单机 MVP 不提前引入消息基础设施。

## 验收与测试

- 新连接可收到 `workspace.ready`，且 `seq` 不回退。
- 客户端传入 `last_event_seq=n` 时，只收到 `seq > n` 的历史事件和之后的实时事件。
- 重复连接/重复广播不会导致同一 `eventId` 被存储两次。
- 历史超过 ring buffer 窗口时，返回“需要快照”的结果，不静默丢数据。
- 慢客户端队列达到上限时不会阻塞其他客户端，也不会无界分配内存。

