# LinkOS 外部插件开发

官方文件、聊天、代码和任务使用原生应用，只有启停由应用管理控制。外部插件使用完整 `.linkos-plugin` 离线包，在受限 iframe 中运行。

## 制作完整包

最小目录为 `manifest.json` 和 `ui/index.html`；脚本、样式及图片均放在 `ui/`。可直接参考 `examples/plugins/resource-viewer`：

```json
{
  "id": "example.resource-viewer",
  "name": "资源查看器",
  "version": "1.0.0",
  "apiVersion": "1.0",
  "entry": { "ui": "ui/index.html" },
  "permissions": ["resource.read:*", "ui.notify"],
  "network": { "mode": "deny" }
}
```

在完成开发环境准备的仓库根目录执行：

```sh
pnpm plugin:pack examples/plugins/resource-viewer .local/resource-viewer.linkos-plugin
pnpm plugin:keygen .local/plugin-signing-key.pem
pnpm plugin:pack examples/plugins/resource-viewer .local/resource-viewer.linkos-plugin --key-file .local/plugin-signing-key.pem
```

打包器自动添加浏览器版 `ui/linkos-sdk.js`，生成 `checksums.json`，可选添加 `signature.ed25519`。清单格式是 `{ "format": 1, "files": [{ "path": "…", "size": 123, "sha256": "…" }] }`；它覆盖 manifest 和全部运行文件，签名覆盖清单的原始字节。不要在签名后重新格式化清单。

`keygen` 输出受信公钥的 `LINKOS_PLUGIN_TRUSTED_KEYS` 配置值，不输出私钥。将公钥写入目标 Gateway 的 `pluginTrustedKeys` 配置或环境变量；私钥只用于打包签名，不能放入插件包。生产必须使用受信签名，开发可以上传未签名包，确认面板会显示未签名状态。

包限 50 MiB，解压总量 128 MiB，单文件 16 MiB，最多 1,000 个 ZIP 条目。拒绝路径穿越、符号链接、重复路径、Windows 大小写/设备名称冲突、清单遗漏、字节不符、缺少入口、不兼容 API、不支持权限及外部网络。不同资源需要使用不同版本号，同版本不能换成另一摘要。

## 安装与生命周期

应用管理上传检查后展示版本、签名和权限差异。管理员确认权限后，宿主启动隔离候选窗口，验证握手成功再提交安装；候选不能使用业务 RPC。安装检查和候选失败均不覆盖当前应用。

| HTTP 接口 | 输入与行为 |
| --- | --- |
| `POST /api/v1/plugin-packages/inspect` | 原始 ZIP 请求体；返回 stageId、manifest、摘要、签名状态、权限差异、expectedRevision 和 expiresAt。暂存有效期 15 分钟。 |
| `POST /api/v1/plugins/:id/ticket` | 已启用应用请求票据；候选检查携带 stageId。返回 src、nonce、协议及过期时间，服务端绑定版本和修订号。 |
| `POST /api/v1/plugins/:id/install` | `{stageId, expectedRevision, probeNonce}`，使用候选票据提交。manifest-only 请求返回 `PLUGIN_PACKAGE_REQUIRED`。 |
| `POST /api/v1/plugins/:id/enable` 等 | enable、disable、rollback、uninstall 均携带 `{expectedRevision}`。修订冲突返回 `PLUGIN_REVISION_CONFLICT`。 |
| `POST /api/v1/plugins/:id/rpc` | 宿主代理 `{method, params, expectedRevision}`，使用宿主身份并再次校验状态/权限。插件不持有登录 token。 |

owner/admin 可管理，member/guest 只能打开已启用应用。启用前确认权限；停用撤销窗口、命令和 RPC，业务数据保留。回滚恢复上一版本的资源字节、manifest、权限和启用状态；无可用上一版本时返回 `PLUGIN_NO_ROLLBACK`，保持现状。卸载保留版本资源和业务数据，再安装仍需完整包。

资源存放在 Gateway 的 `data/plugins/<完整ID>/<版本>/<清单摘要>`。已安装资源不会被启动时的目录扫描覆盖。完整备份覆盖插件注册与版本资源；禁止用旧程序直接打开比它支持的版本更新的数据库。

## SDK 与沙箱

从包内模块导入 SDK，示例中的 `ui/main.js` 演示初始化、资源列表和通知：

```js
import { connectPlugin } from "./linkos-sdk.js";

const sdk = await connectPlugin({
  id: "example.resource-viewer",
  version: "1.0.0",
  apiVersion: "1.0",
});
const user = await sdk.auth.currentUser();
for await (const resource of sdk.resources.list({})) {
  console.log(resource.name);
}
```

请以 `packages/plugin-sdk/src/index.ts` 的实际类型为准。可用能力是当前用户、权限检查、资源 get/list、事件订阅、命令注册、通知和 dispose。读取取用户权限、插件 `resource.read:<类型>` 声明及资源 ACL 的交集；命令需 `ui.command`，通知需 `ui.notify`，事件需 `event.subscribe:<事件类型>`。通配声明仍不允许跨越用户权限。

事件由服务端按真实历史中的 eventId 检查；私聊校验成员身份，管理和任务执行事件不会直接传入沙箱。SDK 不支持资源写入、事件发布和任务执行，调用会返回明确错误。

iframe 使用 `sandbox="allow-scripts"`，没有同源权限和登录 token。资源票据绑定当前会话、插件版本/修订及有效期，只能访问该版本 UI。宿主验证来源窗口、opaque origin、ID、nonce、版本和协议后通过 MessageChannel 通信；版本切换重新挂载并释放旧资源。

Gateway CSP 禁止外部网络、表单和子 iframe；宿主 frame-src 也限制 iframe 自行导航。HTTP 加载错误、协议不兼容和握手超时分别显示，可重试。单窗口故障不改变服务器版本；服务器确认资源损坏后才尝试恢复上一版本。

消息按 UTF-8 字节限 64 KiB，握手/RPC 超时 5 秒，RPC 并发 8 次、每秒 30 次。关闭窗口需 dispose 取消订阅和请求。宿主统一撤销注册；不要依赖窗口卸载之后仍能运行回调。

## 独立验收

```sh
pnpm test:plugins
```

脚本检查空闲端口，创建独立 home 并测试桌面/移动端，不修改日常工作区。验收便携发布程序的 PowerShell 写法：

```powershell
$env:LINKOS_PLUGIN_SMOKE_BINARY = "D:\path\to\linkos.exe"
pnpm test:plugins
```

发布验收使用 HTTPS 同源和临时受信签名；脚本只回收自己创建的进程，保留验收 home 供诊断。
