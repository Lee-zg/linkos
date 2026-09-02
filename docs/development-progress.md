# LinkOS 开发计划与任务进度

> 文档类型：工程执行计划与状态跟踪
>
> 版本：v0.1
>
> 更新时间：2026-09-02
>
> 状态口径：`已完成` 表示仓库中已有可验证实现；`部分完成` 表示已有原型或切片但未满足 PRD 的生产约束；`进行中` 表示当前迭代已开始；`待开始` 表示尚未进入实现；`阻塞` 表示存在需要决策或外部条件的明确阻碍。

## 1. 来源与范围边界

本文件根据以下材料整理，但不替代它们：

| 来源 | 作用 | 本文件的处理方式 |
| --- | --- | --- |
| `docs/prd/linkos-lan-collaboration-prd.md` | 产品范围、协议约束、性能/安全指标、分期目标和验收门槛 | 作为产品要求来源，拆成可执行任务和退出条件 |
| 用户提供的“LinkOS 前端重设计: jsos.dev 桌面 OS 范式”文档 | `apps/web` 的桌面 OS 视觉与交互实现指导 | 作为前端实现依据，记录其已完成项和剩余差距 |
| 用户本次请求 | 对齐文档、开始制定开发计划、补充任务进度文档 | 本次交付仅新增和维护执行文档，不据此宣称 PRD 功能已经完成 |

### 1.1 冲突处理

- PRD 定义的是产品能力和工程约束；它不是当前版本已经交付的功能清单。
- 前端重设计文档早期描述了浅色壁纸方案；后续确认的 LinkOS 桌面 OS 方案选择黑色宇宙/蓝色行星壁纸，窗口和 Dock 仍使用浅色中性令牌。当前实现按后续确认的方案记录。
- 视觉对齐不能放宽鉴权、审计、执行隔离、事件幂等或文件完整性要求。UI 状态为“在线”不等于后端已经具备生产级身份和权限能力。
- 本文件只跟踪当前仓库可落地的工作，不复制 PRD 全文；新增任务必须能对应代码、协议、测试、部署或文档产物。

## 2. 当前基线

### 2.1 已完成或可复验

| 范围 | 状态 | 当前证据 |
| --- | --- | --- |
| 桌面 OS UI Shell | 已完成（原型级） | `apps/web/src/os/` 已拆出桌面、Dock、窗口、Toast、窗口管理器；桌面图标、窗口控制、拖拽/缩放和移动端 Sheet 已实现 |
| `jsos.dev` 视觉转译 | 已完成（原型级） | `apps/web/public/wallpaper.png`、中性浅色窗口令牌、玻璃 Dock、56px 桌面图标和 40px Dock 图标已落地 |
| 前端 API/WS 逻辑拆分 | 已完成（基础版） | `apps/web/src/lib/api.ts` 统一 HTTP 请求；`apps/web/src/lib/useWorkspaceSocket.ts` 处理心跳、重连、事件序号和客户端消息去重 |
| 七个应用入口 | 已完成（原型级） | 系统、文件、聊天、代码、任务、应用管理、设置均可从桌面和 Dock 打开 |
| 前端构建与基础冒烟 | 已完成 | TypeScript、Vite 构建、Gateway/Runner Go 测试、1440x900 和 390x844 浏览器冒烟已通过；完整命令记录见第 8 节 |

### 2.2 与 PRD 的差距

| 工作流 | 状态 | 当前实现 | 下一步交付 |
| --- | --- | --- | --- |
| 工作区发现与身份 | 部分完成 | Gateway 返回 demo discovery；开发态短期 Bearer session 之上已实现三种访问模式（登录/匿名申请审批/完全匿名，见 [`adr/ADR-007-access-modes.md`](adr/ADR-007-access-modes.md)）、前端入口闸门与管理后台审批；仍无 mDNS/UDP、邀请码、设备密钥、refresh token 和撤销 | 实现发现兜底、入网凭据正式方案、设备身份、token 轮换和服务端 RBAC |
| WebSocket 事件 | 部分完成 | Gateway 有有界事件历史与客户端队列，`seq` 与补发窗口经 `LINKOS_DATA_DIR` 持久化到 SQLite，重启后可恢复并有跨重启重放契约测试；前端有重连、心跳和基础 `lastSeq`；服务端写入幂等已落地——`POST /api/v1/messages` 按非空 `clientMsgId` 去重（`hub` 内有界 FIFO 索引，上限 1000，与事件保留窗口一致），重复请求返回原事件（200 `duplicate`、同 `eventId`/`seq`）且不再 `Append`、不再广播，闭合 P0-01「重复 `eventId` 幂等」并有 3 个 Go 契约测试 + 真实 HTTP/WS 冒烟覆盖；去重索引现已跨重启持久（S0-24）——`hub` 构造时从存储保留窗口（`eventStore.Retained()`）重建 `clientMsgId` 索引，配置 `LINKOS_DATA_DIR` 后重启仍能识别重复写入并返回原 `eventId`/`seq`，保证与重放窗口一致（事件被淘汰则其去重保护同步失效），含跨重启 Go 测试 + 真实重启冒烟 | 快照恢复接入、未知事件指标、完整契约测试套件 |
| 文件资源与传输 | 部分完成 | Gateway 已有分片上传 PoC（会话/分片 SHA-256/乱序断点恢复/完整文件校验），会话元数据配置 `LINKOS_DATA_DIR` 后持久化、可跨重启续传；完成的文件进入内容寻址存储（`sha256:<hash>` 资源、同内容去重），`/api/v1/files` 支持 Range 下载（200/206/416）；服务端限额与生命周期治理已就位：单文件大小上限（`LINKOS_UPLOAD_MAX_FILE_SIZE`，默认 10 GiB，超限 413）与活跃会话并发上限（`LINKOS_UPLOAD_MAX_ACTIVE_UPLOADS`，默认 64，超限 429），完成/失败会话自动清理分片目录并释放槽位；CAS 对象池支持总磁盘配额（`LINKOS_CAS_MAX_DISK_BYTES`，默认 0=不限），超额提交按 LRU 淘汰最久未用对象（下载刷新 mtime）、单对象超配额拒绝并返回 507 `INSUFFICIENT_STORAGE`；前端文件应用已接入真实上传/下载：流式整文件 SHA-256（增量哈希、内存占用与文件大小解耦，校验阶段实时进度）、8 MiB 分片、4 路并发、分片重试、断点续传（localStorage 会话索引）、实时三阶段进度、`sha256:` 资源记录（localStorage 持久化）与内容寻址下载 | 可选增强：淘汰引用保护（被淘汰对象的 resourceId 在客户端记录中悬空，下载 404 已有前端提示）与整文件哈希移入 Web Worker（1 GiB 纯 JS 哈希约 60 秒阻塞主线程）；1GB 全量端到端压测已完成（R-04 关闭），1 GiB 真实中断-续传验证已完成（S0-21：仅补发缺失分片、最终哈希一致、续传握手 P95 245ms）。R-06 续传重哈希优化已完成（S0-22）：按 `(name,size,lastModified)` 在 localStorage 缓存整文件哈希，命中缓存的续传跳过约 66s 的全量重算，浏览器 1 GiB 实测"选择文件→续传握手"降至 8ms，端到端"开始传输"落入 3s 预算，并实现陈旧缓存自愈（422→evict+重哈希+重试）。**下一周期候选**：整文件哈希移入 Web Worker（解除首次上传约 60s 的主线程阻塞，进度已可见）与淘汰引用保护 |
| 聊天 | 部分完成 | 有频道样式、消息发送；`clientMsgId` 去重已在客户端渲染与服务端写入两侧落地（S0-23：重复 POST 返回原消息、不重复存储/广播） | 服务端消息模型（持久化/查询）、频道/线程/@成员、搜索、引用和离线补发 |
| 代码工作台 | 部分完成 | 只读模拟目录和代码查看器 | 接入真实资源、语法高亮、编辑器、版本锁、冲突 diff 和保存审计 |
| Runner 与任务 | 部分完成 | Gateway 有 demo 状态模拟；Runner `/jobs` 明确返回 `501 sandbox_not_configured` | Runner 注册协议、队列、隔离执行、日志流、取消、配额和产物 |
| 插件中心 | 部分完成 | 前端开关为本地模拟状态；Gateway 仅返回 demo 插件列表 | manifest 校验、签名、iframe/RPC 隔离、权限 diff、健康检查和回滚 |
| RBAC、审计与安全 | 部分完成 | 已有开发态会话鉴权、`admin` 角色与 `requireAdmin`/`requireActive` 中间件、访问策略与审批记录、审计日志（会话签发/策略变更/审批操作，管理后台可查，配置 `LINKOS_DATA_DIR` 后随 SQLite 持久化）和会话签发速率限制（429）；尚无资源级权限矩阵、审计防篡改、写操作全量覆盖和完整安全测试 | 服务端权限矩阵、审计防篡改与不可抵赖、限流扩展到上传等写路径、上传/命令/XSS 安全测试 |
| 持久化与部署 | 部分完成 | 访问策略、审批记录、审计日志、WS 事件与上传会话元数据可经 `LINKOS_DATA_DIR` 持久化到 SQLite（版本化迁移、重启恢复、跨重启重放与续传测试）；`gateway backup`/`restore` 提供一致性快照与校验恢复；完成的上传以内容寻址对象落盘；鉴权会话按设计保持内存态；Runner 是协议 stub | Windows/Linux 单机部署、备份定期化与异地存放 |
| 分层测试与可观测性 | 部分完成 | 有基础 Go 单测、前端构建和浏览器冒烟 | 契约、集成、故障、安全、性能测试；指标、结构化日志和 trace_id |

## 3. 研发路线图

### Phase 0：技术验证（2 周）

目标是验证不可逆风险，完成后才进入完整 MVP 功能并行开发。

| ID | 任务 | 负责人角色 | 依赖 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| P0-01 | 固化 `DomainEvent`、事件序号、补发窗口和快照协议，形成 ADR-001 | 架构/后端 | `packages/protocol` | 已完成（PoC） | 断线携带 `last_event_seq` 可补齐；超窗口返回快照；重复 `eventId` 幂等。三项验收均已落地：①`last_event_seq` 补发——有界 ring buffer + SQLite 持久化，重启后可恢复并有跨重启重放契约测试（S0-03/S0-12）；②超窗口快照——`replayable=false` 时下发 `workspace.snapshot.required` 提示并提供 `GET /api/v1/workspaces/demo/snapshot` 拉取端点（S0-03；为提示+客户端拉取，非服务端自动推送快照）；③重复 `eventId` 幂等——`POST /api/v1/messages` 按非空 `clientMsgId` 服务端去重，重复请求返回原事件（同 `eventId`/`seq`、200 `duplicate`）且不重复存储/广播，3 个 Go 契约测试 + 真实 HTTP/WS 冒烟 8/8 通过（S0-23）；去重索引经 `eventStore.Retained()` 在 `hub` 构造时从持久化事件窗口重建，配置 `LINKOS_DATA_DIR` 后写入幂等跨网关重启仍成立（与重放窗口同寿命），含跨重启 Go 测试 + 真实重启冒烟 6/6 通过（S0-24）。ADR-001 已成文（S0-02） |
| P0-02 | 1GB 文件分片上传 PoC | 后端/前端 | P0-01 的资源引用约束 | 已完成（PoC） | 8 MiB 分片、4 路并发；中断后从已确认分片继续；最终 SHA-256 一致。S0-20/S0-21 浏览器端到端验证：1 GiB 全量上传三方哈希一致（S0-20）；真实中断后续传仅补发 49/128 缺失分片、最终 SHA-256 与基准一致、无残留分片目录（S0-21）。续传握手 P95 245ms 达标；端到端"开始传输"原受续传前整文件重哈希拖累约 66s（R-06），S0-22 落地按 `(name,size,lastModified)` 的整文件哈希缓存后命中续传跳过重哈希、实测降至 8ms，已落入 3s 预算，R-06 关闭 |
| P0-03 | Runner 隔离执行 PoC，形成 ADR-003 | 执行/安全 | Runner 当前协议 stub | 待开始 | 非 root、无网络、超时、CPU/内存/磁盘配额可验证；失败能清理进程和目录 |
| P0-04 | iframe 插件加载、权限声明和崩溃隔离 PoC | 前端/架构 | `PluginManifest` | 待开始 | 来源校验、sandbox/CSP、消息大小限制；插件崩溃不影响 Shell |
| P0-05 | Windows/Linux 单机部署验证 | DevOps | P0-01 至 P0-04 | 待开始 | 健康检查、数据目录、端口、升级/回滚步骤可按运行手册复现 |
| P0-06 | Phase 0 性能与安全评审 | QA/安全 | P0-01 至 P0-05 | 待开始 | 四项 PoC P95 不超过 PRD 预算的 80%；基本威胁模型评审通过 |

Phase 0 退出门槛：P0-01 至 P0-05 均有可复现实验记录，P0-06 通过；任一高风险项失败时，先记录决策和替代方案，不直接扩大 MVP 范围。

### Phase 1：MVP（6-8 周）

| 周期 | 交付目标 | 主要任务 | 退出条件 |
| --- | --- | --- | --- |
| 第 1-2 周 | 网关骨架、身份、发现、事件协议、UI Shell | P0 结论落地；会话/权限中间件；发现与手动地址；事件 schema；补齐 Shell 离线/错误态 | 新设备可发现并进入工作区；WS 建连 P95 <= 500ms；键盘主流程可用 |
| 第 3-4 周 | 文件、聊天、缓存和断线恢复 | 上传会话/分片/完成接口；Range 下载；消息/频道/线程模型；IndexedDB 摘要与草稿；补发恢复 | 1GB 续传恢复 P95 <= 3s；消息 P95 <= 150ms；重复事件不重复显示 |
| 第 5-6 周 | 代码编辑、版本冲突、Runner 任务 API | 目录/文件资源；编辑器懒加载；`base_version` 乐观锁；Runner 注册、任务队列和状态机 | 1MiB 文件可查看/编辑/保存；冲突可选择覆盖或另存；任务状态可追踪 |
| 第 7 周 | 日志、产物、插件中心、RBAC、审计 | 日志块和背压；取消/超时；产物入库；manifest 生命周期；权限矩阵和审计查询 | 高风险操作有确认和审计；插件升级失败自动回滚；慢客户端不拖垮网关 |
| 第 8 周 | 压测、安全、安装包、文档和试点验收 | 连接/文件/Job 压测；越权/XSS/路径/命令注入测试；安装包；运行手册和诊断包 | 发布门禁全部通过；Windows/Linux 单机安装、升级和回滚可复现 |

### Phase 2：团队试点（4 周）

选择 2-3 个真实团队、20-50 名用户和 1-3 台 Runner，采集首屏、重连、传输成功率、任务失败率和活跃路径。试点期间优先修复权限误配、断线恢复、冲突保存、大文件和插件升级问题。

### Phase 3：持续扩展

按 PRD 的优先级推进 Git/通知/文档/任务看板（P1），CRDT/白板/设备资产/Webhook（P2），多租户/联邦/企业 SSO（P3）。这些能力不进入当前 MVP 交付承诺，除非通过范围评审新增任务。

## 4. 当前迭代：Sprint 0（2026-08-31 至 2026-09-11）

目标：把当前前端原型切片前移为可测的协议和技术验证基线，避免在 demo API 上继续堆叠业务 UI。

| ID | 任务 | 产物 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| S0-01 | 更新 `packages/protocol` 的事件、错误码和 Job/Upload schema 草案 | `packages/protocol/src/index.ts` 已增加 `ErrorCode`、消息幂等、上传会话/分片/完成类型；前端消息 API 已复用共享类型 | 无 | 已完成（草案） |
| S0-02 | 编写 ADR-001：WS `seq`、补发窗口、快照和幂等边界 | [`docs/adr/ADR-001-websocket-replay.md`](adr/ADR-001-websocket-replay.md) | S0-01 | 已完成（PoC 决策） |
| S0-03 | Gateway 事件存储接口 PoC，保留内存实现作为测试 double | `services/gateway/main.go` 已增加可替换 `eventStore`、1,000 条 ring buffer、`last_event_seq` 补发和超窗口快照提示；`main_test.go` 覆盖保留边界和 WebSocket 重连 | S0-02 | 已完成（内存 PoC） |
| S0-04 | 上传协议 PoC：创建会话、分片确认、完成校验 | `services/gateway/uploads.go` 已支持创建/查询上传会话、8 MiB 默认分片、`X-Part-SHA256` 校验、乱序/断点恢复和完整 SHA-256 校验；`uploads_test.go` 覆盖成功与拒绝路径 | S0-01 | 已完成（PoC） |
| S0-05 | Runner 隔离技术调研与负面测试清单 | [`docs/adr/ADR-003-runner-isolation.md`](adr/ADR-003-runner-isolation.md) 已明确默认拒绝执行、候选 rootless container/WASI 边界和负面测试清单；真实适配器仍未启用 | 无 | 已完成（决策/清单） |
| S0-06 | 为桌面 Shell 补一组可重复的浏览器冒烟脚本 | [`docs/web-shell-smoke.md`](web-shell-smoke.md) 已记录 1440x900/390x844 的启动、窗口、Dock、聊天和任务验证；自动化脚本和截图基线仍待补 | 当前前端原型 | 部分完成（手工验证） |
| S0-07 | 记录现有 demo 能力和已知限制，保持本文件与代码同步 | 本文件、`docs/architecture.md`、ADR-001/003 已同步当前实现和未完成边界 | S0-01 至 S0-06 | 已完成（本轮） |
| S0-08 | 建立 Gateway 会话鉴权边界并让前端自动 bootstrap | `services/gateway/auth.go` 提供短期随机 Bearer 会话；工作区 HTTP/WS 路由统一校验；前端 `api.ts`/`useWorkspaceSocket.ts` 自动携带 token；`auth_test.go` 覆盖无效/过期/有效会话；真实 HTTP 冒烟确认无 token 为 401、有 token 为 200 | S0-01 | 已完成（开发态） |
| S0-09 | 三种访问模式与访问控制管理后台 | `services/gateway/access.go`/`auth.go` 实现登录/匿名申请审批/完全匿名签发、`requireActive`/`requireAdmin` 中间件与审批联动；前端 `gate/AccessGate.tsx` 入口闸门、`apps/AdminApp.tsx` 管理后台（访问设置+用户模块）、角色可见性；`access_test.go`/`auth_test.go` 覆盖策略门控、审批生命周期与角色拒绝；浏览器端到端验证通过（见 [`adr/ADR-007-access-modes.md`](adr/ADR-007-access-modes.md)） | S0-08 | 已完成（开发态，内存态） |
| S0-10 | 服务端审计日志与会话签发速率限制 | `services/gateway/audit.go`/`ratelimit.go` 提供有界审计存储（2,000 条环形上限）与按来源 IP 的令牌桶限流（429 `RATE_LIMITED`，桶表 4,096 键回收）；会话签发/策略变更/审批通过/拒绝落审计，`GET /api/v1/admin/audit-log` 管理端查询；管理后台新增审计日志分区；`audit_test.go`/`ratelimit_test.go` 覆盖顺序与上限、审计落点、端点鉴权、突发/补充/限流/多键隔离；浏览器冒烟确认审计分区与 429 实测生效 | S0-09 | 已完成（开发态，内存态） |
| S0-11 | Gateway 访问状态持久化（存储接口 + SQLite） | `services/gateway/persist.go` 定义 `persistBackend` 存储接口并以内存后端为默认与测试 double；`sqlite_backend.go` 用纯 Go `modernc.org/sqlite` 实现策略/审批记录/审计的落库、版本化迁移（`schema_migrations`）与审计 2,000 条有界回收；`LINKOS_DATA_DIR` 未设置保持内存态、设置后使用 `<dir>/gateway.db`；`persist_test.go`/`sqlite_backend_test.go` 覆盖内存不残留、往返、上限、迁移幂等与重启恢复（含 `acc_`/`aud_` 序号续编）；真实重启冒烟确认旧 token 401、策略/记录/审计恢复、序号续编 | S0-10 | 已完成（访问态持久化） |
| S0-12 | WS 事件流持久化 | `persistBackend` 扩展 `loadEvents`/`appendEvent`；`memoryEventStore` 从后端预载保留窗口并续编 `seq`，写入时落库；SQLite v2 迁移新增 `events` 表（1,000 条有界回收）；新增 4 个测试覆盖事件往返、上限、重启续编与跨重启 WS 重放契约；真实冒烟确认重启后 `last_event_seq=0` 连接得到 `replayable=true`、重启前事件按原 `seq` 重放、新事件续编 | S0-11 | 已完成 |
| S0-13 | 上传会话元数据持久化 | `persistBackend` 扩展 `loadUploadSessions`/`saveUploadSession`；SQLite v3 迁移新增 `uploads` 表，会话在创建/分片确认/完成/失败四个写入点 upsert 快照；`newUploadStoreWithBackend` 启动时预载会话并把 `verifying` 降级为 `uploading`（完成请求幂等可重放）；`main.go` 接入共享后端；新增 3 个测试覆盖往返与 upsert、跨重启续传、状态降级，全量测试绿；真实冒烟确认重启后既有会话恢复 `receivedParts=[0]`、续传剩余分片并通过完整 SHA-256 校验 | S0-12 | 已完成 |
| S0-14 | 数据备份与恢复 | `persistBackend` 扩展 `backupTo`：SQLite 用 `VACUUM INTO` 在 `<dataDir>/backups` 生成一致性快照并输出清单（大小/SHA-256/schema 版本），内存后端明确拒绝；`backup.go` 的 `restoreBackup` 校验 `integrity_check` 与 schema 后原子替换 `gateway.db`（临时文件+旧库暂存回滚、清理残留 WAL/SHM），非法/缺失备份被拒绝且原库不受影响；`gateway backup`/`gateway restore <file>` 离线 CLI 子命令；5 个新测试覆盖快照一致性、内存拒绝、恢复回滚、非法拒绝与清单字段；真实冒烟确认备份后改策略、恢复后策略回滚到备份时点、非法备份被拒 | S0-13 | 已完成 |
| S0-15 | 内容寻址存储与 Range 下载 | `files.go` 新增 `contentStore`：完成的上传经整文件 SHA-256 校验后提交到 `<uploadRoot>/objects/<h2>/<hash>.bin`，同内容去重为单一对象，`resourceId` 变为 `sha256:<hash>`；`GET /api/v1/files/{resourceId}/content` 经 `http.ServeContent` 支持全量 200 / 区间 206 / 越界 416 / 未知 404（`Accept-Ranges: bytes`）；`uploads.go` 完成路径改走 CAS 提交，`main.go` 注册鉴权路由；新增 2 个测试覆盖 CAS 提交与去重、下载状态机，既有完成/续传测试改断言内容寻址结果；真实冒烟确认全量、`bytes=5-9` 区间、越界与未知资源的响应均符合预期 | S0-14 | 已完成 |
| S0-16 | 前端真实上传/下载接入 | `uploads.ts` 新增分片上传客户端：WebCrypto 整文件 SHA-256、8 MiB 分片、4 路并发池、分片 2 次重试、`X-Part-SHA256` 逐片校验、localStorage 会话索引支持断点续传、内容寻址下载（Bearer 鉴权 + blob 保存）；FilesApp 改为真实交互——拖放/选择即上传，传输队列实时显示三阶段进度（校验内容/传输分片/合并校验）与进度条，最近列表展示 `sha256:` 资源记录（localStorage 持久化）与下载按钮；`tsc --noEmit` + `vite build` 通过；浏览器端到端冒烟确认 3 KB/20 MiB（3 分片）/200 MiB（25 分片）上传成功且 CAS 对象字节级哈希一致、实时进度可观测、刷新后记录保留、下载内容哈希一致、重复上传验证客户端与服务端双重去重 | S0-15 | 已完成 |
| S0-17 | 上传生命周期清理与服务端限额 | 完成/失败的会话自动清理分片目录（`removeSessionDirectory`，CAS 对象不受影响），终结态会话释放活跃槽位；`uploadStore` 增加 `maxFileSize`（默认 10 GiB）与 `maxActiveUploads`（默认 64）限额，经 `LINKOS_UPLOAD_MAX_FILE_SIZE`/`LINKOS_UPLOAD_MAX_ACTIVE_UPLOADS` 配置，非法值回退默认；超限创建分别返回 413 `UPLOAD_TOO_LARGE` 与 429 `TOO_MANY_ACTIVE_UPLOADS`；顺带修复会话 ID 仅用 `UnixNano` 在低分辨率时钟下碰撞导致会话互相覆盖的问题（改为附加原子序号并补回归测试）；新增 6 个测试覆盖完成/失败清理、大小与并发限额、环境变量解析与 ID 唯一性，全量测试绿；真实冒烟确认 413/429 拒绝、完成后分片目录删除而 CAS 保留、失败释放槽位 | S0-16 | 已完成 |
| S0-18 | 大文件流式哈希与常内存传输 | 前端上传改为流式处理：整文件 SHA-256 经 `js-sha256` 增量哈希器按 8 MiB 窗口顺序读取（`file.slice().arrayBuffer()`），分片发送时再按需从文件读取，取消整文件 `arrayBuffer()` 驻留，内存占用与文件大小解耦（R-04 内存项关闭）；`UploadProgress` 新增 `hashedBytes`，传输队列在"校验内容"阶段显示实时哈希进度（纯 JS 哈希较慢，避免大文件看似冻结）；后端确认分片写入/完成组装均为 `io.Copy` 流式、CAS 提交为 `os.Rename`，无需改动；`tsc --noEmit`/`vite build` 通过；浏览器端到端冒烟确认 300 MB 随机文件上传成功、流式哈希与服务端整文件校验一致、磁盘 `sha256sum` 与页内下载再哈希三方一致、分片目录清理保持生效、控制台无错误 | S0-17 | 已完成 |
| S0-19 | CAS 对象池总磁盘配额与淘汰策略 | `contentStore` 增加 `maxDiskBytes`（经 `LINKOS_CAS_MAX_DISK_BYTES` 配置，0=不限）；提交新对象超额时按最旧 mtime 逐个淘汰（下载经 `touchObject` 刷新 mtime，策略即 LRU），淘汰写运行日志；单对象大于整个配额直接拒绝（`errCASQuotaExceeded`，临时文件清理），完成路径映射为 507 `INSUFFICIENT_STORAGE` 并 markFailed；去重命中不受配额核算影响；新增 7 个测试（最旧淘汰/超额拒绝/0 不限/去重豁免/下载刷新 LRU/环境变量解析/完成 507）全绿，全量 `go test -count=1` 连跑 3 次稳定；真实冒烟（配额 64 字节）确认 A+B 入库、下载 A 后提交 C 淘汰 B（A/C 保留、B 下载 404）、超配额 D 返回 507、失败会话目录清理、淘汰日志落盘 | S0-18 | 已完成 |
| S0-20 | 1GB 全量端到端压测（R-04 收尾） | 纯验证任务，无代码改动。浏览器真实上传 1 GiB 随机文件（128 个 8 MiB 分片，网关默认配置：配额不限、10 GiB 文件上限）：JS 堆峰值 18.2 MB（1 秒间隔 `performance.memory` 采样，完成后回落 11.3 MB），内存占用与文件大小解耦成立；流式哈希 1 GiB 约 60 秒（纯 JS ~18 MB/s），分片传输 ~10 MB/s，端到端约 3 分钟；客户端流式哈希、服务端整文件校验与磁盘 `sha256sum` 三方一致（`2a48f90f…`）；Range 抽查 `bytes=1048576-1048675` 返回 206 且 100 字节与原文件同区间哈希一致；完成后无残留 `up_*` 分片目录、uploads 目录收敛为恰好 1 GiB CAS 对象；控制台无应用错误；压测产物全部清理；已知限制：整文件哈希阻塞主线程约 1 分钟（进度可见），可选移入 Web Worker | S0-19 | 已完成 |
| S0-21 | 1GB 断点续传真实中断-恢复验证与续传握手 P95 计时（P0-02 收尾） | 纯验证任务，无代码改动。真实中断-续传：1 GiB 文件上传至 79 个已确认分片后中断，续传仅补发 49 个缺失分片（非全量 128），最终 `contentHash` 与基准一致（`26e921eb…`）、状态 `completed`、无残留 `up_*` 目录、磁盘 `sha256sum` == 基准、内存有界（堆峰值 50.4 MB、最低 17.2 MB）。续传握手 P95：单次 `GET /uploads/:id` 318ms；30 次 `GET` 的 P95 = 245ms（min 76 / median 231 / max 328）；`GET`→首个分片间隔 824ms，协议层"开始传输" ≈ 1.1s，远低于 3s 预算。P0-02 验收全部满足（8 MiB 分片、4 路并发、中断后从已确认分片继续、最终 SHA-256 一致）。**未达标项**：端到端"开始传输"因续传前必须重算整文件 SHA-256（`resumeKey` 内嵌 `contentHash`，见 `uploads.ts:142`），1 GiB 重哈希约 65.7s、首个分片在变更后 66.9s 才发出，违反"<=3s"字面指标（见 R-06）。建议修复（本轮未实施）：按 `(name,size,lastModified)` 在 localStorage 缓存整文件哈希以跳过续传重哈希；Web Worker 仅解除主线程阻塞，不解决 66s | S0-20 | 已完成（验证）；续传重哈希优化待排期（R-06） |
| S0-22 | 续传重哈希优化（R-06 修复） | 新增纯模块 `apps/web/src/lib/hashCache.ts`：按文件身份 `(name,size,lastModified)` 在 localStorage（`linkos.file-hash-cache`）缓存整文件 SHA-256，注入式存储接口、无 DOM/依赖、上限 200 条按插入序淘汰；`uploadFile` 改为缓存优先——命中则跳过整文件流式重哈希、直接以缓存哈希查续传会话，未命中则哈希后回填缓存；针对服务端完成路径的整文件哈希二次校验（`uploads.go` 完成时 `actualHash != contentHash` → 422 `UPLOAD_PART_INVALID`），实现陈旧缓存自愈：捕获 422 后 evict + 重哈希 + 重试一次。TDD 落地（先写 9 个 `node:test` 用例看其失败再实现），新增前端单测基础设施（Node 内置 `node --test` + 原生 TS 类型擦除，零新依赖；`tsconfig` 排除 `*.test.ts`，根 `package.json` 增 `test:web` 脚本）。验证：`node --test` 9/9 绿、`tsc --noEmit` 0 错、`vite build` 成功、`go test ./services/gateway/` 通过；浏览器真实冒烟（1 GiB）：中断后续传，命中缓存使"选择文件→续传握手 GET"从约 66s 降至 8ms（跳过整文件重哈希），仅补发 46 个缺失分片（82 个已确认分片跳过），最终 `resourceId`/磁盘 `sha256sum` 与基准一致（`49bc20df…`）、会话索引完成后清空、无残留 `up_*` 目录、堆内存有界（34–42 MB）；陈旧缓存恢复冒烟（3 MB，注入错误 64 位十六进制哈希）：缓存命中→创建会话→分片 200→完成 422→自动 evict+重哈希+新会话重试→完成 201，缓存自愈为正确哈希、最终 `resourceId` 正确、全程约 1.4s、控制台仅预期的 422 网络日志无未处理异常 | S0-21 | 已完成 |
| S0-23 | 服务端事件幂等：`clientMsgId` 去重（P0-01「重复 `eventId` 幂等」收尾） | `services/gateway/main.go` 把 `emit` 拆为加锁外壳 + `emitLocked` 核心，新增 `hub.publishMessage(body,channelId,clientMsgId)`：以客户端提供的非空 `clientMsgId` 为幂等键，命中则返回原始事件且 `duplicate=true`，不再 `Append`（不递增 `seq`、不铸造新 `eventId`）也不再向 WS 客户端广播；`hub` 增加有界 FIFO 去重索引（`seen` map + `seenOrder`，上限 `messageDedupRetention=1000`，与事件保留窗口一致，超限淘汰最旧），空 `clientMsgId` 永不去重。`/api/v1/messages` 改用 `publishMessage` 并返回协议既有的 `AcceptedMessage` 契约（`messageId`/`serverMsgId`=事件 `eventId`、`seq`、`status`：新建 201 `accepted`／重复 200 `duplicate`），落实 ADR-001「HTTP 写入接口必须接受重复 `clientMsgId`，返回原消息结果，而不是再次创建消息」。TDD 落地（先写 3 个 Go 测试看其因 `publishMessage` 未定义而失败再实现）：同 `clientMsgId` 两次发布仅一条存储事件/一次广播且第二次返回原 `eventId`+`seq`、不同 `clientMsgId` 各自追加、空 `clientMsgId` 不去重。验证：`gofmt -l` 空、`go vet`（gateway+runner）净、`go test ./services/gateway/ -count=1` 通过；真实 HTTP/WS 冒烟（活动网关 :8787，Node 内置 `fetch`+`WebSocket`）：同一 `clientMsgId` 两次 POST → 201 `accepted`（seq 2）+ 200 `duplicate`（同 `eventId`/seq），不同 `clientMsgId` → 201（seq 3），WS 客户端仅收到 2 条 `chat.message.created` 广播（重复被抑制）、无重复 `eventId`，8/8 断言通过 | S0-12 | 已完成 |
| S0-24 | 写入幂等跨重启持久：从持久化事件窗口重建 `clientMsgId` 去重索引 | S0-23 的去重索引为内存态，网关重启即重置——重启后客户端携带相同 `clientMsgId` 的重试会被当作新消息再次存储并广播。本轮让索引跨重启持久，且**不新增 SQLite 表/schema**：`eventStore` 接口增 `Retained() []event`（返回保留窗口内事件的副本，最旧优先），`newHubWithStore` 在构造时调用 `seedDedupFromRetained()` 遍历保留窗口、对 `chat.message.created` 事件经 `clientMsgIDFromPayload`（兼容进程内 `map[string]string` 与从 SQLite JSON 解码的 `map[string]interface{}` 两种 payload 形态）提取非空 `clientMsgId` 并重建索引。由此去重保护与重放窗口天然一致：事件仍在保留窗口内则其 `clientMsgId` 幂等仍有效，事件被淘汰则幂等保护同步失效（`messageDedupRetention=1000 == eventRetention=1000`，重建不会触发二次淘汰）。TDD 落地（先写 `TestPublishMessageDedupSurvivesRestart` 看其因重启后 `seen` 为空、第二个 hub 追加了新事件而失败再实现）：同一 SQLite 后端先发布 `clientMsgId`，关闭后以相同后端重建 hub，相同 `clientMsgId` 必须返回 `duplicate=true` 且原 `eventId`/`seq`、`CurrentSeq` 不前进。验证：`gofmt -l` 空、`go vet`（gateway+runner）净、`go test ./services/gateway/ -count=1` 通过（含新增跨重启测试与既有 3 个幂等测试）；真实重启冒烟（活动网关 :8787 + `LINKOS_DATA_DIR` SQLite，Node 内置 `fetch`）：boot#1 POST `clientMsgId` → 201 `accepted`（seq 2），停网关→以相同 data 目录 boot#2→同一 `clientMsgId` POST → 200 `duplicate` 且返回**原** `eventId`/`seq 2`；为隔离登录本身会发 `access.record.created` 事件对 `seq` 的占用，用单次登录下「新消息 A（seq 4）→重复（不追加）→新消息 B（seq 5 == A+1）」夹逼证明重复写入未推进 `seq`，6/6 断言通过 | S0-23 | 已完成 |

Sprint 0 的完成标准：至少完成 S0-01、S0-02、S0-03 的评审和测试；S0-04、S0-05 必须给出可执行的技术结论；S0-06 能在 1440x900 与 390x844 复现核心窗口交互。

## 5. 任务状态规则与验收模板

### 5.1 状态流转

```text
待开始 -> 进行中 -> 待评审 -> 已完成
              \-> 阻塞 -> 进行中
```

状态变更必须在提交、评审或测试结果出现时更新，不根据“代码已经写了”直接标记完成。发现实现只覆盖 demo/本地模式时，应使用“部分完成”并写明缺口。

### 5.2 单项任务 Definition of Done

- 用户路径同时覆盖空态、加载、成功、失败、重试、离线和权限不足状态。
- 服务端执行权限校验；前端隐藏按钮不作为安全控制。
- HTTP/WS/插件协议有版本、schema、错误码和幂等策略。
- 关键路径具备结构化日志、指标、`trace_id`；写操作有审计记录。
- 至少有一个故障测试和一个越权/输入安全测试。
- 断线、慢客户端和低带宽场景不造成无界内存或队列增长。
- 文档补齐配置、迁移、回滚、故障排查和已知限制。

### 5.3 高风险能力的额外门槛

运行任务、启用网络、覆盖版本冲突、跨工作区分享、删除资源和安装插件必须显示操作者、资源范围、命令/网络策略、配额和可撤销性，并在服务端审计后才执行。

## 6. 风险、阻塞与决策记录

| ID | 风险/决策 | 影响 | 当前应对 | 责任角色 | 状态 |
| --- | --- | --- | --- | --- | --- |
| R-01 | Runner 当前是安全协议 stub，不能执行任务 | 高 | 先做隔离 PoC 和负面测试；未通过前保持 `501 sandbox_not_configured` | 执行/安全 | 开放 |
| R-02 | Gateway 使用内存状态，重启会丢失事件和业务数据 | 高 | 已关闭：`persistBackend` 存储接口 + SQLite 后端覆盖访问策略/审批记录/审计/WS 事件/上传会话元数据（重启恢复、跨重启重放与续传测试），`gateway backup`/`restore` 提供一致性快照与校验恢复；鉴权会话按设计为易失态；`clientMsgId` 写入去重索引原为内存态（S0-23），现经 `eventStore.Retained()` 在 `hub` 构造时从持久化事件窗口重建（S0-24），故写入幂等已跨重启覆盖、寿命与重放窗口一致（事件被淘汰则其去重保护同步失效，属可接受的窗口边界），无需新增表/schema；上传数据目录（分片/成品文件）的备份仍需文件系统手段，随内容寻址存储一并解决 | 后端 | 已关闭（已缓解） |
| R-03 | 前端“在线”目前主要代表 WS 可达，不代表身份/RBAC 完整 | 高 | 已增加开发态会话中间件、访问模式闸门、审计与签发限流（审计可随 SQLite 持久化）；仍需设备身份、token 轮换、角色权限矩阵和审计防篡改 | 架构/后端 | 开放 |
| R-04 | 1GB 传输可能造成浏览器内存、磁盘和带宽压力 | 中 | 服务端分片/断点恢复/Range 已就绪，前端已接入真实传输（8 MiB 分片、4 路并发上限、分片重试、断点续传）并经 200 MiB 端到端验证；服务端已增加单文件大小与活跃会话并发限额（超限 413/429）并在完成/失败后清理分片目录；前端已改为流式哈希与按需分片读取（`js-sha256` 增量 hasher，内存占用与文件大小解耦），300 MB 端到端冒烟确认客户端流式哈希、服务端整文件校验与磁盘 `sha256sum` 三方一致；CAS 对象池总磁盘配额与 LRU 淘汰已实现（`LINKOS_CAS_MAX_DISK_BYTES`，超额淘汰最久未用对象、单对象超配额 507），磁盘压力收敛；1 GiB 浏览器端到端压测通过：JS 堆峰值 18.2 MB、流式哈希约 60 秒（~18 MB/s）、传输 ~10 MB/s、三方哈希一致、Range 206 抽查一致、无残留分片目录，内存/磁盘/带宽三项压力均验证收敛 | 前后端 | 已关闭（已缓解） |
| R-05 | iframe 插件边界与模块化加载的取舍未锁定 | 中 | Phase 0 用故障隔离和性能数据形成 ADR-002 | 架构/前端 | 开放 |
| R-06 | 续传前必须重算整文件 SHA-256，端到端恢复远超 3s 预算 | 中 | 已关闭：S0-22 新增 `hashCache.ts`，按文件身份 `(name,size,lastModified)` 在 localStorage 缓存整文件 SHA-256；`uploadFile` 缓存优先——命中即跳过整文件重哈希、直接查续传会话。浏览器 1 GiB 真实中断-续传冒烟：选择文件→续传握手 `GET` 从约 66s 降至 8ms，仅补发 46 个缺失分片、最终哈希与基准一致、内存有界、无残留分片目录。针对服务端完成路径的整文件哈希二次校验，实现陈旧缓存自愈（捕获 422 `UPLOAD_PART_INVALID` → evict + 重哈希 + 重试一次），3 MB 注入错误哈希冒烟确认 422→自动重试→201 成功、缓存自愈、全程约 1.4s。残留约束：缓存以 `lastModified` 为身份，同尺寸同 mtime 但内容不同的极端场景由服务端 422 + 客户端自愈兜底；Web Worker 化整文件哈希（解除主线程阻塞）仍为可选增强，与本风险无关 | 前后端 | 已关闭（已缓解） |
| D-01 | 桌面视觉采用黑色宇宙壁纸，窗口/Dock 保持浅色中性 | 中 | 按最新确认方案实施；不添加主题切换 | 产品/设计 | 已记录 |
| D-02 | MVP 编辑采用乐观锁 + diff，不做 CRDT | 中 | 将实时协同编辑放到 P2 | 产品/架构 | 已记录 |
| D-03 | 协议先在 `packages/protocol` 固化，再写 Gateway/Runner/UI | 高 | 所有跨模块任务将 schema 作为前置产物 | 架构 | 已记录 |

## 7. 测试与性能门禁

### 7.1 当前已执行

- 前端 TypeScript `tsc --noEmit` 和 Vite 生产构建。
- 前端单元测试 `node --test "apps/web/src/**/*.test.ts"`（根 `package.json` 的 `test:web`）：采用 Node 内置测试运行器 + 原生 TS 类型擦除，零新依赖；测试文件经 `tsconfig` 的 `exclude` 排除，`tsc`/`vite build` 不处理。当前覆盖 `hashCache`（9 用例：键格式、命中/未命中、往返、evict、`lastModified` 变更不命中、刷新插入序、读/写异常容错、超上限淘汰最旧）。
- `go test ./services/gateway/... ./services/runner/...`。
- `git diff --check`。
- 浏览器 1440x900 与 390x844：壁纸、桌面图标、Dock、Toast、窗口打开/最小化/恢复/置顶、任务状态、聊天发送。
- 浏览器控制台无错误。

`pnpm --filter @linkos/web typecheck/build` 在当前无交互终端会触发 pnpm 的 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，因此上一轮使用仓库已安装的 TypeScript/Vite 运行时完成等价检查；后续 CI 必须恢复 pnpm 命令作为正式门禁。

### 7.2 MVP 必测指标

| 指标 | 目标 |
| --- | ---: |
| 首屏可交互 P95 | <= 1.5s |
| 工作区发现 P95 | <= 2s |
| WebSocket 建连并订阅 P95 | <= 500ms |
| 消息端到端 P95 | <= 150ms |
| 任务状态可见 P95 | <= 300ms |
| 1GB 续传开始传输 P95 | <= 3s |
| 网关空载内存 | <= 150 MiB |
| 100 个在线连接增量 | <= 100 MiB |

> 续传指标实测（S0-21/S0-22）：续传握手 `GET /uploads/:id` 的 P95 = 245ms、协议层"开始传输"（握手→首个分片）≈ 1.1s（S0-21）。端到端"开始传输"原受续传前整文件重哈希拖累（1 GiB 约 66s，R-06）；S0-22 落地按 `(name,size,lastModified)` 的整文件哈希缓存后，命中缓存的续传跳过重哈希——浏览器 1 GiB 真实中断-续传冒烟实测"选择文件→续传握手 GET"仅 8ms，端到端"开始传输"已落入 3s 预算，R-06 关闭。缓存未命中（首次上传）仍需一次整文件流式哈希（1 GiB 约 60s，进度可见），为内容寻址与去重所必需；可选增强：移入 Web Worker 解除主线程阻塞。

### 7.3 测试分层

1. 单元：权限、分片校验、事件幂等、状态机、manifest。
2. 契约：HTTP/WS schema、插件 SDK、Runner 协议。
3. 集成：上传-引用-下载、消息-代码引用、代码-任务-产物。
4. 故障：网关重启、网络抖动、Runner 掉线、重复事件、慢客户端。
5. 安全：越权、路径穿越、XSS、命令注入、沙箱逃逸基线、敏感日志。
6. 性能：100/500/1,000 连接，10/100 GB 文件，100 个并行 Job。

## 8. 更新记录

| 日期 | 更新 | 依据 |
| --- | --- | --- |
| 2026-08-31 | 建立执行计划；记录桌面 OS 原型、API/WS 拆分和 Gateway/Runner demo 差距；启动 Sprint 0 | 当前工作树、PRD、架构文档和已完成浏览器冒烟 |
| 2026-08-31 | 完成 S0-01 至 S0-03：协议草案、WS replay ADR、Gateway 内存事件存储与补发 PoC；TypeScript、Vite、Go 测试通过 | `packages/protocol/src/index.ts`、`docs/adr/ADR-001-websocket-replay.md`、`services/gateway/main.go`、`services/gateway/main_test.go` |
| 2026-08-31 | 完成 S0-04 上传协议 PoC：分片写盘、哈希校验、断点状态和完整性测试；明确鉴权、配额、Range 下载和持久化会话仍属 MVP | `services/gateway/uploads.go`、`services/gateway/uploads_test.go` |
| 2026-08-31 | 完成 S0-05 Runner 隔离决策与负面测试清单；继续保持 `/jobs` 默认拒绝，等待隔离适配器和安全评审 | `docs/adr/ADR-003-runner-isolation.md` |
| 2026-08-31 | 完成 S0-06 手工冒烟验证：1440x900 桌面端与 390x844 移动端的壁纸、图标、Dock、窗口恢复和 Sheet 行为通过；自动化脚本待 Playwright 依赖纳入后补齐 | `docs/web-shell-smoke.md`、本地浏览器 DOM 验证 |
| 2026-08-31 | 完成 S0-08 开发态会话鉴权：随机短期 token、统一 HTTP/WS 中间件、前端自动 bootstrap 和鉴权回归测试；最终设备身份/RBAC/TLS 仍属 MVP | `services/gateway/auth.go`、`services/gateway/auth_test.go`、`docs/adr/ADR-006-session-authentication.md` |
| 2026-09-01 | 完成 S0-09 访问控制：三种访问模式（登录/匿名申请审批/完全匿名）、口令管理员、入口闸门、管理后台（访问设置+用户模块）与审批实时联动；`go test`、TypeScript、构建和浏览器端到端验证通过；策略/记录/会话仍为内存态，审计与速率限制列为 S0-10 | `services/gateway/access.go`、`access_test.go`、`auth.go`、`apps/web/src/gate/AccessGate.tsx`、`apps/web/src/apps/AdminApp.tsx`、`docs/adr/ADR-007-access-modes.md` |
| 2026-09-01 | 启动 S0-10 服务端审计与速率限制：审计存储、写操作落审计、管理端审计查询、会话签发限流与前端审计分区 | 本文件、`services/gateway`（进行中） |
| 2026-09-01 | 完成 S0-10：有界审计存储与签发/策略/审批审计落点、`/api/v1/admin/audit-log`、会话签发令牌桶限流（429 `RATE_LIMITED`）、管理后台审计分区；顺带修复审批通过后本地 profile 快照滞留 `pending`；`go test`、TypeScript、构建通过，浏览器冒烟确认审计条目与限流生效；审计与限流均为内存态，持久化和写路径扩展限流留待存储层落地 | `services/gateway/audit.go`、`audit_test.go`、`ratelimit.go`、`ratelimit_test.go`、`apps/web/src/apps/AdminApp.tsx`、`apps/web/src/gate/AccessGate.tsx` |
| 2026-09-01 | 启动 S0-11 访问状态持久化：`persistBackend` 存储接口、内存后端保持默认、SQLite 后端与 `LINKOS_DATA_DIR` 接线 | 本文件、`services/gateway`（进行中） |
| 2026-09-01 | 完成 S0-11：`persistBackend` 接口 + 纯 Go SQLite 后端（版本化迁移、审计 2,000 条有界回收），策略/审批记录/审计经 `LINKOS_DATA_DIR` 落库，未设置时保持内存默认；7 个新测试覆盖往返、上限、迁移幂等与重启恢复（`acc_`/`aud_` 序号续编）；真实重启冒烟确认旧 token 401、策略/记录/审计恢复；事件流与上传元数据持久化、备份恢复留待下一迭代 | `services/gateway/persist.go`、`persist_test.go`、`sqlite_backend.go`、`sqlite_backend_test.go`、`main.go`、`apps/web/src/apps/AdminApp.tsx` |
| 2026-09-01 | 启动 S0-12 WS 事件流持久化：`persistBackend` 事件方法、`memoryEventStore` 后端接线、SQLite v2 `events` 表与跨重启重放契约测试 | 本文件、`services/gateway`（进行中） |
| 2026-09-01 | 完成 S0-12：WS 事件经 `persistBackend` 落 SQLite（v2 迁移、1,000 条有界回收），重启后 `seq` 续编、补发窗口可重放；4 个新测试（往返/上限/重启续编/跨重启 WS 重放）全绿，`go test -count=1` 通过；真实冒烟确认重启后 `replayable=true`、重启前事件按原 `seq` 重放、新事件续编；剩余持久化范围收窄为上传元数据与备份恢复 | `services/gateway/persist.go`、`sqlite_backend.go`、`sqlite_backend_test.go`、`main.go`、`main_test.go` |
| 2026-09-01 | 启动 S0-13 上传会话元数据持久化：`persistBackend` 上传方法、SQLite v3 `uploads` 表、`uploadStore` 后端接线与跨重启续传测试 | 本文件、`services/gateway`（进行中） |
| 2026-09-01 | 完成 S0-13：上传会话元数据经 `persistBackend` 落 SQLite（v3 迁移，创建/分片确认/完成/失败四点 upsert 快照），重启预载会话并把 `verifying` 降级为 `uploading` 保证完成幂等；3 个新测试（往返与 upsert/跨重启续传/状态降级）全绿，`go test -count=1` 通过；真实冒烟确认重启后已收分片恢复、续传完成且整文件 SHA-256 校验通过；R-02 剩余范围收窄为备份恢复 | `services/gateway/persist.go`、`sqlite_backend.go`、`sqlite_backend_test.go`、`uploads.go`、`uploads_test.go`、`main.go` |
| 2026-09-01 | 启动 S0-14 备份与恢复：`persistBackend.backupTo`（VACUUM INTO 快照）、`restoreBackup` 校验与原子替换、`gateway backup`/`restore` 离线 CLI 与测试 | 本文件、`services/gateway`（进行中） |
| 2026-09-01 | 完成 S0-14：SQLite `VACUUM INTO` 一致性快照（清单含大小/SHA-256/schema 版本），`restoreBackup` 经 `integrity_check`+schema 校验后原子替换 `gateway.db`（旧库暂存可回滚、清理残留 WAL/SHM），离线 `gateway backup`/`gateway restore <file>` CLI；5 个新测试（快照一致性/内存拒绝/恢复回滚/非法拒绝/清单字段）全绿；真实冒烟确认备份→改策略→恢复后策略回滚到备份时点、非法备份被拒；R-02 关闭 | `services/gateway/backup.go`、`backup_test.go`、`persist.go`、`sqlite_backend.go`、`main.go` |
| 2026-09-01 | 启动 S0-15 内容寻址存储与 Range 下载：`contentStore` CAS 提交与去重、`/api/v1/files` 下载路由、完成路径改造与测试 | 本文件、`services/gateway`（进行中） |
| 2026-09-01 | 完成 S0-15：完成的上传按整文件 SHA-256 提交到 `<uploadRoot>/objects/<h2>/<hash>.bin`（同内容去重），`resourceId` 变为 `sha256:<hash>`；`GET /api/v1/files/{resourceId}/content` 支持 200/206/416/404；2 个新测试（CAS 提交与去重、下载状态机）全绿，既有完成/续传测试改断言内容寻址结果，`go test -count=1` 通过；真实冒烟确认全量/区间/越界/未知下载行为与 CAS 布局 | `services/gateway/files.go`、`files_test.go`、`uploads.go`、`uploads_test.go`、`main.go` |
| 2026-09-01 | 启动 S0-16 前端真实上传/下载接入：`uploads.ts` 分片上传客户端（整文件 SHA-256/8 MiB 分片/4 路并发/分片重试/断点续传）与 FilesApp 真实传输改造（传输队列进度、最近记录、内容寻址下载） | 本文件、`apps/web`（进行中） |
| 2026-09-01 | 完成 S0-16：前端文件应用接入真实上传/下载——`uploads.ts` 提供 WebCrypto 整文件 SHA-256、8 MiB 分片、4 路并发池、分片 2 次重试、localStorage 断点续传索引与已完成记录（上限 100 条），内容寻址下载经 Bearer 鉴权保存为文件；FilesApp 拖放/选择即上传，传输队列三阶段实时进度，最近列表展示 `sha256:` 资源并提供下载；`tsc --noEmit`/`vite build` 通过；浏览器端到端冒烟确认 3 KB/20 MiB（3 分片）/200 MiB（25 分片）上传成功且 CAS 对象字节级哈希一致、实时进度（88%）可观测、刷新后记录保留、下载内容哈希一致、重复上传客户端与服务端双重去重（仍 3 对象）；已知限制：整文件哈希一次性读入内存（R-04）、完成会话的分片文件未清理 | `apps/web/src/lib/uploads.ts`、`apps/web/src/apps/FilesApp.tsx` |
| 2026-09-01 | 启动 S0-17 上传生命周期清理与服务端限额：完成/失败会话的分片目录清理、`maxFileSize`/`maxActiveUploads` 限额与环境变量配置、会话 ID 碰撞修复与回归测试 | 本文件、`services/gateway`（进行中） |
| 2026-09-01 | 完成 S0-17：完成/失败的上传会话自动删除分片目录（`removeSessionDirectory`，CAS 对象保留），终结态释放活跃槽位；`uploadStore` 增加 `maxFileSize`（默认 10 GiB，413 `UPLOAD_TOO_LARGE`）与 `maxActiveUploads`（默认 64，429 `TOO_MANY_ACTIVE_UPLOADS`），经 `LINKOS_UPLOAD_MAX_FILE_SIZE`/`LINKOS_UPLOAD_MAX_ACTIVE_UPLOADS` 配置、非法值回退默认；顺带修复会话 ID 仅用 `UnixNano` 在低分辨率时钟（Windows 100ns 量化）下碰撞导致会话互相覆盖的问题（附加原子序号 `up_<ns>_<seq>`）；新增 6 个测试（完成/失败清理、大小与并发限额、环境变量解析、ID 唯一性）全绿，全量 `go test -count=1` 连跑 3 次稳定通过；真实冒烟（限额 100 字节/2 并发）确认超限 413、并发超限 429、完成后分片目录删除而 CAS 对象完整、失败会话释放槽位且不占活跃计数 | `services/gateway/uploads.go`、`services/gateway/uploads_lifecycle_test.go` |
| 2026-09-01 | 启动 S0-18 大文件流式哈希与常内存传输：前端增量哈希（`js-sha256`）替换整文件 `arrayBuffer()` + WebCrypto 一次性摘要，分片按需读取，哈希阶段实时进度 | 本文件、`apps/web`（进行中） |
| 2026-09-01 | 完成 S0-18：`uploads.ts` 整文件 SHA-256 改为 `js-sha256` 增量哈希器按 8 MiB 窗口顺序流式读取，分片发送时按需 `file.slice().arrayBuffer()` 重读，取消整文件驻留，内存占用与文件大小解耦（R-04 内存项关闭）；`UploadProgress` 新增 `hashedBytes`，FilesApp 传输队列在"校验内容"阶段显示已哈希字节数；后端复查确认分片写入与完成组装本就是 `io.Copy` 流式、CAS 提交为 `os.Rename`，无需改动；`tsc --noEmit`/`vite build` 通过（bundle +7 KB gzip）；浏览器端到端冒烟：300 MB 随机文件上传成功，客户端流式哈希 `8b94d160…` 与服务端整文件校验一致，磁盘 `sha256sum` 与页内下载再哈希三方一致（314572800 字节），传输队列实时进度可观测（42% 采样），分片目录清理保持生效，控制台无错误；已知限制：纯 JS 哈希吞吐低于 WebCrypto（300 MB 约数秒，进度可见） | `apps/web/src/lib/uploads.ts`、`apps/web/src/apps/FilesApp.tsx`、`apps/web/package.json` |
| 2026-09-01 | 启动 S0-19 CAS 对象池总磁盘配额与淘汰策略：`contentStore` 配额核算、最旧 mtime 淘汰（下载刷新实现 LRU）、单对象超配额拒绝与 507 映射、环境变量接线 | 本文件、`services/gateway`（进行中） |
| 2026-09-01 | 完成 S0-19：CAS 对象池支持总磁盘配额（`LINKOS_CAS_MAX_DISK_BYTES`，默认 0=不限，非法值回退），超额提交在锁内扫描用量并按最旧 mtime 逐个淘汰（下载经 `touchObject` 刷新 mtime，策略即 LRU，淘汰写运行日志）；单对象大于整个配额返回 `errCASQuotaExceeded` 并清理临时文件，完成路径映射 507 `INSUFFICIENT_STORAGE` 且会话 markFailed；去重命中不做配额核算；新增 7 个测试（最旧淘汰/超额拒绝/0 不限/去重豁免/下载刷新 LRU/环境变量解析/完成 507）全绿，`go test -count=1` 连跑 3 次稳定；真实冒烟（配额 64 字节）：A+B 入库、下载 A 后提交 C 精确淘汰 B（A/C 下载 200、B 404）、70 字节 D 完成返回 507、失败会话目录清理、网关淘汰日志确认；已知限制：被淘汰对象的 resourceId 在客户端"最近记录"中悬空（前端下载失败已有 toast 提示），引用保护与对象 GC 列为可选增强 | `services/gateway/files.go`、`services/gateway/files_quota_test.go`、`services/gateway/uploads.go` |
| 2026-09-02 | 启动 S0-20 1GB 全量端到端压测（R-04 收尾）：生成 1 GiB 随机文件并预计算基准 `sha256sum`，网关默认配置 + Vite 5178 + 浏览器真实上传，页内 1 秒间隔采样 JS 堆与阶段进度 | 本文件、`.smoke-s020`（进行中） |
| 2026-09-02 | 完成 S0-20：浏览器真实上传 1 GiB 随机文件（128 个 8 MiB 分片）全链路通过——JS 堆峰值 18.2 MB（完成后回落 11.3 MB），内存与文件大小解耦成立；流式哈希约 60 秒（~18 MB/s）、分片传输 ~10 MB/s、端到端约 3 分钟；客户端流式哈希 `2a48f90f…`、服务端整文件校验与磁盘 `sha256sum` 三方一致；Range 抽查 `bytes=1048576-1048675` 返回 206 且 100 字节与原文件同区间哈希一致；完成后无残留 `up_*` 分片目录（uploads 目录收敛为恰好 1 GiB CAS 对象）；控制台无应用错误；R-04 关闭（内存/磁盘/带宽三项压力均验证收敛）；压测产物（1 GiB 源文件、CAS 对象、目录）全部清理；已知限制：整文件哈希阻塞主线程约 1 分钟（进度可见），可选移入 Web Worker | 无代码改动（纯验证），证据见本文件 S0-20 行 |
| 2026-09-02 | 启动 S0-21 1GB 断点续传真实中断-恢复验证与续传握手 P95 计时（P0-02 收尾）：生成 1 GiB 随机文件并预计算基准 `sha256sum`，网关默认配置 + Vite 5178 + 浏览器真实上传，传输中途停网关制造中断，重启后从已确认分片续传并采样握手时延与内存 | 本文件、`.smoke-s021`（进行中） |
| 2026-09-02 | 完成 S0-21：1 GiB 真实中断-续传验证通过——中断时已确认 79 个分片，续传仅补发 49 个缺失分片（非全量 128），最终 `contentHash` 与基准一致（`26e921eb…`）、状态 `completed`、无残留 `up_*` 目录、磁盘 `sha256sum` == 基准、内存有界（堆峰值 50.4 MB、最低 17.2 MB）。续传握手 P95：单次 `GET /uploads/:id` 318ms，30 次 `GET` 的 P95 = 245ms（min 76 / median 231 / max 328），`GET`→首个分片间隔 824ms，协议层"开始传输" ≈ 1.1s，落入 3s 预算。P0-02 验收全部满足（8 MiB 分片、4 路并发、中断后从已确认分片继续、最终 SHA-256 一致），P0-02 标记已完成（PoC）。**未达标项**：端到端"开始传输"约 66s——`resumeKey` 内嵌整文件 `contentHash`（`uploads.ts:142`），续传前必须完整重算 SHA-256 才能查到可续传会话，1 GiB 重哈希约 65.7s、首个分片在变更后 66.9s 才发出，违反"<=3s"字面指标；记为 R-06，建议修复（按 `(name,size,lastModified)` 缓存整文件哈希以跳过续传重哈希）本轮未实施，留待下一迭代 TDD 落地。纯验证任务，无代码改动；压测产物全部清理 | 无代码改动（纯验证），证据见本文件 S0-21 行、R-06 |
| 2026-09-02 | 启动 S0-22 续传重哈希优化（R-06 修复）：TDD 落地纯模块 `hashCache.ts`（按 `(name,size,lastModified)` 缓存整文件 SHA-256、注入式存储、上限淘汰），`uploadFile` 改为缓存优先并对服务端完成路径 422 实现陈旧缓存自愈（evict+重哈希+重试一次）；新增前端单测基础设施（Node 内置 `node --test` + 原生 TS 类型擦除、`tsconfig` 排除测试文件、根 `test:web` 脚本）；计划以 1 GiB 中断-续传与 3 MB 注入错误哈希两个浏览器冒烟验证提速与自愈 | 本文件、`apps/web`（进行中）、`.smoke-s022`（进行中） |
| 2026-09-02 | 完成 S0-22：新增 `apps/web/src/lib/hashCache.ts`（`hashCacheKey`/`getCachedHash`/`setCachedHash`/`evictCachedHash`，注入式 `HashCacheStorage`、`MAX_HASH_CACHE_ENTRIES=200` 按插入序淘汰、读写异常容错），`uploadFile` 重构为缓存优先 + `runUpload` 抽取 + `isHashMismatch`（422 `UPLOAD_PART_INVALID`）触发的 evict+重哈希+重试一次自愈路径；新增前端单测基础设施：`node --test "apps/web/src/**/*.test.ts"`（根 `package.json` 增 `test:web`，Node 内置运行器 + 原生 TS 类型擦除、零新依赖），`apps/web/tsconfig.json` 增 `exclude: ["src/**/*.test.ts"]` 使 `tsc`/`vite build` 不处理测试。TDD：先写 9 个 `hashCache.test.ts` 用例看其失败再实现。验证全绿：`node --test` 9/9、`tsc --noEmit` 0 错、`vite build` 成功（231.80 kB / 70.94 kB gzip）、`go test ./services/gateway/` 通过。浏览器真实冒烟（网关默认配置 + Vite 5178）：①1 GiB 中断-续传——首次上传（缓存未命中）填充 `linkos.file-hash-cache`（键 `big.bin:1073741824:<mtime>`→`49bc20df…`，与磁盘基准一致），传输至 82 个已确认分片后刷新页面中断，重选同一文件命中缓存："选择文件→续传握手 `GET /uploads/:id`"仅 8ms（对比 S0-21 约 66s），仅补发 46 个缺失分片、跳过 82 个已确认分片，完成后 `resourceId`/磁盘 `sha256sum` == 基准 `49bc20df…`、会话索引清空、无残留 `up_*` 目录、堆内存有界（34–42 MB）；②陈旧缓存自愈——向缓存注入错误 64 位十六进制哈希（`deadbeef…`）后上传 3 MB 文件：缓存命中→`POST /uploads` 201→分片 200→`POST /complete` 422→自动 evict+重哈希+新会话重试→`POST /complete` 201，缓存自愈为正确哈希 `5fee06ba…`、最终 `resourceId` 正确、全程约 1.4s、失败会话无残留分片目录与孤立 CAS 对象、控制台仅预期的 422 网络日志无未处理异常。R-06 关闭；压测产物（1 GiB+3 MB 源文件、CAS 对象、目录）全部清理 | `apps/web/src/lib/hashCache.ts`、`apps/web/src/lib/hashCache.test.ts`、`apps/web/src/lib/uploads.ts`、`apps/web/tsconfig.json`、`package.json`、本文件 |
| 2026-09-02 | 启动 S0-23 服务端事件幂等（P0-01「重复 `eventId` 幂等」收尾）：定位缺口——`POST /api/v1/messages` 接受客户端 `clientMsgId` 但仅作 payload 数据，`emit`→`Append` 每次都递增 `seq` 并铸造新 `eventId`，重试会重复存储并向所有 WS 客户端重复广播；计划 TDD 落地 `hub.publishMessage` 按非空 `clientMsgId` 去重（有界 FIFO 索引），命中返回原事件、不再 `Append`/广播，HTTP 返回协议既有 `AcceptedMessage` 契约（201 `accepted`／200 `duplicate`），并以活动网关 HTTP/WS 冒烟验证 | 本文件、`services/gateway`（进行中）、`.smoke-s023`（进行中） |
| 2026-09-02 | 完成 S0-23：`services/gateway/main.go` 把 `emit` 拆为加锁外壳 + `emitLocked` 核心，新增 `hub.publishMessage(body,channelId,clientMsgId)`——以非空 `clientMsgId` 为幂等键，命中返回原始事件且 `duplicate=true`，不再 `Append`（不递增 `seq`、不铸造新 `eventId`）、不再广播；`hub` 增有界 FIFO 去重索引（`seen` map + `seenOrder`，`messageDedupRetention=1000`，与事件保留窗口一致，超限淘汰最旧），空 `clientMsgId` 永不去重；`/api/v1/messages` 改用 `publishMessage` 并返回 `AcceptedMessage`（`messageId`/`serverMsgId`=事件 `eventId`、`seq`、`status`：新建 201 `accepted`／重复 200 `duplicate`），落实 ADR-001「写入接口接受重复 `clientMsgId`、返回原消息结果而非再次创建」。TDD：先写 3 个 Go 测试（同 `clientMsgId` 仅一事件/一广播且第二次返回原 `eventId`+`seq`、不同 `clientMsgId` 各自追加、空 `clientMsgId` 不去重）看其因 `publishMessage` 未定义而失败再实现。验证全绿：`gofmt -l` 空、`go vet`（gateway+runner）净、`go test ./services/gateway/ -count=1` 通过（runner 无测试）。真实 HTTP/WS 冒烟（活动网关 :8787、`LINKOS_UPLOAD_DIR` 指向临时目录，Node v24 内置 `fetch`+`WebSocket`，登录态 `login`+passcode 取 `accessToken`，WS 经 `access_token` 查询参数鉴权）：同一 `clientMsgId` 两次 POST → 201 `accepted`（seq 2，`eventId` `evt_2_…`）+ 200 `duplicate`（同 `messageId`/`serverMsgId`/seq），不同 `clientMsgId` → 201 `accepted`（seq 3）；WS 客户端仅收到 2 条 `chat.message.created` 广播（重复被抑制）、每条 `clientMsgId` 各一、无重复 `eventId`，8/8 断言通过；冒烟后停网关（:8787 healthz 归 000）、`.smoke-s023` 产物清理。P0-01 三项验收全部满足，标记已完成（PoC）。已知限制：去重索引为内存态、重启后重置（事件本身已持久化），跨重启写入幂等列为后续增强（见 R-02、§2.2 WebSocket 行） | `services/gateway/main.go`、`services/gateway/main_test.go`、本文件 |
| 2026-09-02 | 启动 S0-24 写入幂等跨重启持久（S0-23 已知限制收尾）：定位缺口——S0-23 的 `clientMsgId` 去重索引仅存于 `hub` 内存（`seen`/`seenOrder`），网关重启即清空，重启后客户端携带相同 `clientMsgId` 的重试会被当作新消息再次 `Append`+广播；计划不新增 SQLite 表/schema，而是给 `eventStore` 增 `Retained() []event`，在 `newHubWithStore` 构造时从持久化事件窗口重建索引（`seedDedupFromRetained` + `clientMsgIDFromPayload`），使去重寿命与重放窗口一致；TDD 先写 `TestPublishMessageDedupSurvivesRestart`（同一 SQLite 后端发布→关闭→重建 hub→相同 `clientMsgId` 须 `duplicate=true`、原 `eventId`/`seq`、`CurrentSeq` 不前进），并以真实重启冒烟（boot#1 POST→停网关→boot#2 相同 data 目录→重复 POST）验证 | 本文件、`services/gateway`（进行中）、`.smoke-s024`（进行中） |
| 2026-09-02 | 完成 S0-24：`services/gateway/main.go` 给 `eventStore` 接口增 `Retained() []event`（`memoryEventStore` 返回保留窗口副本，最旧优先），`newHubWithStore` 构造时调用 `seedDedupFromRetained()`——遍历 `store.Retained()`、对 `chat.message.created` 事件经 `clientMsgIDFromPayload`（兼容进程内 `map[string]string` 与从 SQLite JSON 解码的 `map[string]interface{}` 两种 payload 形态）提取非空 `clientMsgId` 并 `recordSeenLocked` 重建索引，**不新增表/schema**；由此写入幂等跨网关重启成立、寿命与重放窗口一致（事件被淘汰则去重保护同步失效，`messageDedupRetention=1000 == eventRetention=1000` 故重建不触发二次淘汰）。TDD：先写 `TestPublishMessageDedupSurvivesRestart` 看其因重启后 `seen` 为空、第二个 hub 追加了新事件（`main_test.go:286`）而失败再实现。验证全绿：`gofmt -l` 空、`go vet`（gateway+runner）净、`go test ./services/gateway/ -count=1` 通过（含新增跨重启测试 + 既有 3 个幂等测试）。真实重启冒烟（活动网关 :8787 + `LINKOS_DATA_DIR`/`LINKOS_UPLOAD_DIR` 指向 `.smoke-s024` 临时目录，Node v24 内置 `fetch`，两阶段 before/after 脚本经 `state.json` 传递重启前事件）：boot#1 登录 + POST `clientMsgId=smoke-restart-1` → 201 `accepted`（seq 2，`eventId` `evt_2_20260902094656.714275900`）；停网关（healthz 归 000、无监听）→以**相同** data 目录 boot#2→同一 `clientMsgId` POST → 200 `duplicate` 且返回**原** `eventId`/`seq 2`（证明索引已从 SQLite 事件窗口重建）。为隔离「登录本身会发 `access.record.created` 事件、占用一个 `seq`」对断言的干扰（首轮 after 因误设 `other.seq==first.seq+1` 而 FAIL，实测新消息落在 seq 4 而非 3，定位为登录事件占 seq 3、非实现缺陷），改用单次登录下夹逼法：新消息 A（seq 4，201）→重复（200，不追加）→新消息 B（seq 5 == A+1，201），精确证明重复写入未推进 `seq`，6/6 断言通过（脚本尾部 `process.exit` 触发的 libuv `UV_HANDLE_CLOSING` 断言为 Node-on-Windows 已知退出竞态，在全部断言打印通过之后发生，与冒烟逻辑无关）；冒烟后停网关（healthz 归 000、无监听）、`.smoke-s024` 产物清理。R-02 中「去重索引内存态、跨重启幂等未覆盖」缺口闭合，P0-01 ③ 补充跨重启证据 | `services/gateway/main.go`、`services/gateway/main_test.go`、本文件、`docs/architecture.md` |

后续每次迭代至少更新：任务状态、代码/测试证据、风险变化、下一周期优先级。状态跟踪以仓库实际结果为准，PRD 需求变更必须先更新范围和验收门槛，再调整任务状态。
