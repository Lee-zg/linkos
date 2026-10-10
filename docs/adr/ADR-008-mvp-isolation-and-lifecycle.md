# ADR-008：MVP 隔离执行与插件生命周期

## 状态

已接受（MVP）

## 决策

- Runner 只通过 Docker/Podman 容器执行，容器使用非 root 用户、只读根文件系统、`network=none`、丢弃 capability、`no-new-privileges`、CPU/内存/PID 限制和独立临时工作目录。
- 引擎不可用时返回 `RUNNER_UNAVAILABLE`，禁止回退到宿主机任意命令。
- Runner 注册使用一次性配置令牌，注册后签发可轮换 credential；生产环境没有令牌即拒绝。Gateway 不自动向任意配置 URL 回传 credential，心跳由受控部署流程发送。
- 官方文件、聊天、代码和任务保留原生应用，启停统一由工作区应用目录控制；系统应用不可停用，官方版本随主程序交付。
- 外部插件使用完整 ZIP 离线包，清单覆盖 manifest 与全部运行资源，Ed25519 签名覆盖清单原始字节。首期只接受 API 1.0、包内 HTML UI 和 deny 网络；检查、权限确认及候选沙箱握手后提交安装。
- iframe 保留 allow-scripts，使用会话/版本/修订绑定资源票据，不传登录 token。Gateway CSP 和宿主 frame-src 共同限制网络与导航；校验窗口来源、nonce、ID、版本/协议后，通过 MessageChannel 提供有权限过滤的只读 RPC。
- schema 10 使用独立插件注册表和不可变版本资源。回滚同时恢复 manifest、权限、启用状态和相符资源；无上一版本不修改状态。修订号防止并发覆盖，持久化成功才广播。客户端故障只影响窗口，服务器确认资源损坏才尝试上一版本恢复。

## 后果

核心工作区不依赖 Runner。启用生产 Runner 才需要 rootless engine；生产外部插件必须使用受信签名包，内嵌官方应用无需用户签名。开发允许未签名完整包并展示其状态。完整备份覆盖注册表、当前/上一版本资源和受信公钥；新数据库拒绝不兼容程序降级。插件运行与验收约定见 [插件开发手册](../plugin-development.md) 和 [迭代记录](../iterations/application-management.md)。

Runner 仅采集任务声明的 glob，单文件上限 8 MiB、任务总量上限 16 MiB，经内容哈希写入 Gateway CAS 后提供 artifact 下载；更大产物留在后续迭代。
