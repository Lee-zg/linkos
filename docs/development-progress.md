# LinkOS 开发计划与任务进度

> 文档类型：工程执行计划与状态跟踪
>
> 版本：v0.1
>
> 更新时间：2026-09-01
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
| WebSocket 事件 | 部分完成 | Gateway 有有界事件历史与客户端队列，`seq` 与补发窗口经 `LINKOS_DATA_DIR` 持久化到 SQLite，重启后可恢复并有跨重启重放契约测试；前端有重连、心跳和基础 `lastSeq` | 快照恢复接入、未知事件指标和完整契约测试套件 |
| 文件资源与传输 | 部分完成 | Gateway 已有分片上传 PoC（会话/分片 SHA-256/乱序断点恢复/完整文件校验），会话元数据配置 `LINKOS_DATA_DIR` 后持久化、可跨重启续传；前端仍为模拟资源列表与上传交互，无 Range 下载与内容寻址 | 前端接入真实上传流程、并发控制、Range 下载与内容寻址存储 |
| 聊天 | 部分完成 | 有频道样式、消息发送和 `clientMsgId` 去重 | 服务端消息模型、频道/线程/@成员、搜索、引用和离线补发 |
| 代码工作台 | 部分完成 | 只读模拟目录和代码查看器 | 接入真实资源、语法高亮、编辑器、版本锁、冲突 diff 和保存审计 |
| Runner 与任务 | 部分完成 | Gateway 有 demo 状态模拟；Runner `/jobs` 明确返回 `501 sandbox_not_configured` | Runner 注册协议、队列、隔离执行、日志流、取消、配额和产物 |
| 插件中心 | 部分完成 | 前端开关为本地模拟状态；Gateway 仅返回 demo 插件列表 | manifest 校验、签名、iframe/RPC 隔离、权限 diff、健康检查和回滚 |
| RBAC、审计与安全 | 部分完成 | 已有开发态会话鉴权、`admin` 角色与 `requireAdmin`/`requireActive` 中间件、访问策略与审批记录、审计日志（会话签发/策略变更/审批操作，管理后台可查，配置 `LINKOS_DATA_DIR` 后随 SQLite 持久化）和会话签发速率限制（429）；尚无资源级权限矩阵、审计防篡改、写操作全量覆盖和完整安全测试 | 服务端权限矩阵、审计防篡改与不可抵赖、限流扩展到上传等写路径、上传/命令/XSS 安全测试 |
| 持久化与部署 | 部分完成 | 访问策略、审批记录、审计日志、WS 事件与上传会话元数据可经 `LINKOS_DATA_DIR` 持久化到 SQLite（版本化迁移、重启恢复、跨重启重放与续传测试）；`gateway backup`/`restore` 提供一致性快照与校验恢复；鉴权会话按设计保持内存态；Runner 是协议 stub | 内容寻址存储、Windows/Linux 单机部署 |
| 分层测试与可观测性 | 部分完成 | 有基础 Go 单测、前端构建和浏览器冒烟 | 契约、集成、故障、安全、性能测试；指标、结构化日志和 trace_id |

## 3. 研发路线图

### Phase 0：技术验证（2 周）

目标是验证不可逆风险，完成后才进入完整 MVP 功能并行开发。

| ID | 任务 | 负责人角色 | 依赖 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| P0-01 | 固化 `DomainEvent`、事件序号、补发窗口和快照协议，形成 ADR-001 | 架构/后端 | `packages/protocol` | 待开始 | 断线携带 `last_event_seq` 可补齐；超窗口返回快照；重复 `eventId` 幂等 |
| P0-02 | 1GB 文件分片上传 PoC | 后端/前端 | P0-01 的资源引用约束 | 待开始 | 8 MiB 分片、4 路并发；中断后从已确认分片继续；最终 SHA-256 一致 |
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
| R-02 | Gateway 使用内存状态，重启会丢失事件和业务数据 | 高 | 已关闭：`persistBackend` 存储接口 + SQLite 后端覆盖访问策略/审批记录/审计/WS 事件/上传会话元数据（重启恢复、跨重启重放与续传测试），`gateway backup`/`restore` 提供一致性快照与校验恢复；鉴权会话按设计为易失态；上传数据目录（分片/成品文件）的备份仍需文件系统手段，随内容寻址存储一并解决 | 后端 | 已关闭（已缓解） |
| R-03 | 前端“在线”目前主要代表 WS 可达，不代表身份/RBAC 完整 | 高 | 已增加开发态会话中间件、访问模式闸门、审计与签发限流（审计可随 SQLite 持久化）；仍需设备身份、token 轮换、角色权限矩阵和审计防篡改 | 架构/后端 | 开放 |
| R-04 | 1GB 传输可能造成浏览器内存、磁盘和带宽压力 | 中 | 分片、流式 hash、并发上限、Range 和断点恢复 PoC | 前后端 | 开放 |
| R-05 | iframe 插件边界与模块化加载的取舍未锁定 | 中 | Phase 0 用故障隔离和性能数据形成 ADR-002 | 架构/前端 | 开放 |
| D-01 | 桌面视觉采用黑色宇宙壁纸，窗口/Dock 保持浅色中性 | 中 | 按最新确认方案实施；不添加主题切换 | 产品/设计 | 已记录 |
| D-02 | MVP 编辑采用乐观锁 + diff，不做 CRDT | 中 | 将实时协同编辑放到 P2 | 产品/架构 | 已记录 |
| D-03 | 协议先在 `packages/protocol` 固化，再写 Gateway/Runner/UI | 高 | 所有跨模块任务将 schema 作为前置产物 | 架构 | 已记录 |

## 7. 测试与性能门禁

### 7.1 当前已执行

- 前端 TypeScript `tsc --noEmit` 和 Vite 生产构建。
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

后续每次迭代至少更新：任务状态、代码/测试证据、风险变化、下一周期优先级。状态跟踪以仓库实际结果为准，PRD 需求变更必须先更新范围和验收门槛，再调整任务状态。
