# Contributing to LinkOS

感谢参与 LinkOS。请先阅读 `README.md` 和 `docs/architecture.md`，了解当前技术验证范围。

## 提交变更

1. 小步提交，每个 PR 聚焦一个能力或一个协议变化。
2. 跨模块变化先更新 `packages/protocol` 的类型和示例。
3. UI 变化需要说明空态、加载态、错误态、离线态和移动端行为。
4. 执行、网络、插件权限或文件访问变化必须附威胁模型与负面测试。
5. 提交前运行 `pnpm --filter @linkos/web typecheck`、`pnpm --filter @linkos/web build` 和对应的 `go test ./...`。

## 代码风格

- TypeScript 使用严格模式，避免无界状态和全量列表渲染。
- Go 提交前运行 `gofmt`。
- 事件必须包含版本、幂等 ID、工作区 ID 和序号。
- 不要把密钥、消息正文、文件内容或本地路径写进日志和 issue。

