# Security Policy

## Reporting a vulnerability

请不要在公开 issue 中披露安全漏洞。请通过 GitHub Security Advisories 或项目维护者提供的私密渠道提交，内容包含影响范围、复现步骤、受影响版本和可行的缓解措施。

## Security boundaries

- 当前 v0.1.0 的 Gateway 使用 demo 数据和开发模式 CORS，不适合生产。
- Runner 的任意命令执行保持关闭，直到沙箱适配器通过安全评审。
- 生产部署必须启用 TLS、设备身份、RBAC、审计、限额和隔离执行。

