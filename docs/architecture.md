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

当前 Gateway 仍为开发模式：使用内存短期会话、demo 资源和本地上传目录。访问策略、审批记录、审计日志、WS 事件与上传会话元数据已通过 `persistBackend` 存储接口落地 SQLite 后端：设置 `LINKOS_DATA_DIR` 后持久化到 `<dir>/gateway.db`（版本化迁移、重启恢复、跨重启 `last_event_seq` 重放、上传会话跨重启续传，上传数据目录由 `LINKOS_UPLOAD_DIR` 固定以便恢复），未设置时保持内存默认；鉴权会话按设计为易失态。离线运维命令 `gateway backup` 用 `VACUUM INTO` 在 `<dir>/backups` 生成一致性快照（清单含大小/SHA-256/schema 版本），`gateway restore <file>` 校验完整性与 schema 后原子替换数据库。已完成事件序号、1,000 条有界历史、`last_event_seq` 补发和超窗口快照提示的 PoC；已完成上传会话、分片 SHA-256 校验、乱序/断点恢复和完整文件校验的 PoC；已接入开发态随机 Bearer 会话和工作区路由统一鉴权。下一步接入设备身份/RBAC、内容寻址文件存储、Range 下载和事件快照恢复；Runner 在 Linux 上使用 rootless container/WASI 进行隔离执行。

上传 PoC 路径：

```text
POST  /api/v1/uploads
GET   /api/v1/uploads/:id
PATCH /api/v1/uploads/:id/parts/:partNo
POST  /api/v1/uploads/:id/complete
GET   /api/v1/files/:resourceId/content   (支持 Range，206/416)
```

完成的上传按整文件 SHA-256 提交到 `<uploadRoot>/objects/<h2>/<hash>.bin` 内容寻址存储（同内容去重），`resourceId` 即 `sha256:<hash>`；下载端点由 `http.ServeContent` 提供全量与区间响应。对象池支持总磁盘配额（`LINKOS_CAS_MAX_DISK_BYTES`，默认 0=不限）：超额提交按最旧修改时间淘汰对象，下载会刷新 mtime，因此实际策略为 LRU；单对象大于整个配额时拒绝提交并返回 507 `INSUFFICIENT_STORAGE`；被淘汰对象的 `resourceId` 下载将得到 404（暂无引用保护）。

分片编号从 `0` 开始，分片内容通过请求体发送，SHA-256 通过 `X-Part-SHA256` 请求头提交。上传/下载路由已接入开发态会话鉴权，支持乱序断点续传、跨进程恢复（元数据持久化）与 Range 下载，Web 前端已接入真实传输（8 MiB 分片、4 路并发、分片重试、断点续传与内容寻址下载），整文件 SHA-256 经增量哈希器流式计算、分片按需读取，内存占用与文件大小解耦；服务端已实现单文件大小限额（`LINKOS_UPLOAD_MAX_FILE_SIZE`，默认 10 GiB，超限 413）、活跃会话并发限额（`LINKOS_UPLOAD_MAX_ACTIVE_UPLOADS`，默认 64，超限 429）、完成/失败会话的分片目录清理（CAS 对象保留）以及 CAS 对象池总磁盘配额与 LRU 淘汰；1 GiB 文件已经浏览器端到端压测验证（JS 堆峰值 18.2 MB、三方哈希一致、Range 206 抽查一致、无残留分片目录），并已通过真实中断-续传验证（中断于 79 个已确认分片，续传仅补发 49 个缺失分片、最终 SHA-256 与基准一致、内存有界；续传握手 `GET /uploads/:id` P95 245ms）；端到端"开始传输"原受续传前整文件重哈希拖累（`resumeKey` 内嵌内容哈希，1 GiB 约 66s，R-06），现已修复：前端按文件身份 `(name,size,lastModified)` 在 localStorage 缓存整文件 SHA-256，命中缓存的续传跳过重哈希（浏览器 1 GiB 真实中断-续传冒烟实测"选择文件→续传握手 `GET`"降至 8ms，仅补发缺失分片、最终哈希与基准一致），并针对服务端完成路径的整文件哈希二次校验（422 `UPLOAD_PART_INVALID`）实现陈旧缓存自愈（evict + 重哈希 + 重试一次，3 MB 注入错误哈希冒烟确认 422→重试→成功、缓存自愈），R-06 关闭；仍缺生产级加固，不应直接用于生产部署。

## 事件约束

- `eventId` 幂等：写入接口 `POST /api/v1/messages` 以非空 `clientMsgId` 为幂等键，在 `hub` 内有界 FIFO 索引（上限 1000，与事件保留窗口一致）中去重——重复请求返回原始事件（同 `eventId`/`seq`、HTTP 200 `duplicate`），不再追加事件、不再向 WS 客户端广播；空 `clientMsgId` 不去重。该索引在 `hub` 构造时从存储的保留窗口（`eventStore.Retained()`）重建，故配置持久化后端后写入幂等跨网关重启仍成立，其寿命与重放窗口一致：事件仍在保留窗口内则其 `clientMsgId` 幂等有效，事件被淘汰则幂等保护同步失效。无需为此新增表或 schema。
- `seq` 在工作区内单调递增。
- 大对象只发送资源引用，不塞进 WebSocket payload。
- 慢客户端使用有界队列，超过预算则降级为快照。
