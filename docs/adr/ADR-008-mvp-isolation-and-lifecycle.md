# ADR-008：MVP 隔离执行与插件生命周期

## 状态

已接受（MVP）

## 决策

- Runner 只通过 Docker/Podman 容器执行，容器使用非 root 用户、只读根文件系统、`network=none`、丢弃 capability、`no-new-privileges`、CPU/内存/PID 限制和独立临时工作目录。
- 引擎不可用时返回 `RUNNER_UNAVAILABLE`，禁止回退到宿主机任意命令。
- Runner 注册使用一次性配置令牌，注册后签发可轮换 credential；生产环境没有令牌即拒绝。Gateway 不自动向任意配置 URL 回传 credential，心跳由受控部署流程发送。
- 插件 manifest 先做 API、入口、权限和网络策略校验，再按受信 Ed25519 公钥验证签名。iframe 宿主通过 sandbox/CSP、来源校验、消息大小和 RPC 超时隔离。
- 插件记录保存上一版本 manifest，安装新版本后可执行真实 rollback；状态变化和权限变化写入审计链。

## 后果

rootless engine、TLS 和受信公钥成为生产部署前置条件；开发环境可以使用 unsigned manifest 和本地 engine。Runner 仅采集任务声明的 glob，单文件上限 8 MiB、任务总量上限 16 MiB，经内容哈希写入 Gateway CAS 后提供 artifact 下载；更大产物和自动健康探针留在后续迭代。
