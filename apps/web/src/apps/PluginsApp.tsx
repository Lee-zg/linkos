import { useMemo, useRef, useState } from "react";
import type { PluginPackageInspection, PluginRecord } from "@linkos/protocol";
import {
  AlertCircle,
  ArrowUpRight,
  Package,
  PackagePlus,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  ApiError,
  inspectPluginPackage,
  installPlugin,
  setPluginStatus,
} from "../lib/api";
import { builtinAppIDs, isBuiltinPlugin } from "../lib/plugin-policy";
import { useWorkspace } from "../lib/workspace";
import { useSession } from "../lib/session";
import { useAppRegistry } from "../os/app-registry";
import { useWindowManager } from "../os/window-manager";
import { useToast } from "../os/Toaster";
import { PluginFrame } from "./PluginFrame";
import { Modal } from "./FileActions";

const statusNames: Record<string, string> = {
  enabled: "已启用",
  disabled: "已停用",
  installed: "待启用",
  uninstalled: "已卸载",
  failed: "异常",
  discovered: "待安装",
};
const button =
  "rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-40";
type Action = "enable" | "disable" | "rollback" | "uninstall";
function errorText(error: unknown) {
  return error instanceof ApiError
    ? `${error.message}${error.traceId ? ` · ${error.traceId}` : ""}`
    : error instanceof Error
      ? error.message
      : "应用操作失败";
}
export function PluginsApp() {
  const catalog = useAppRegistry(),
    toast = useToast();
  const { connected } = useWorkspace(),
    { profile } = useSession(),
    { open } = useWindowManager();
  const canManage = profile.role === "owner" || profile.role === "admin";
  const [query, setQuery] = useState(""),
    [source, setSource] = useState("all"),
    [status, setStatus] = useState("all"),
    [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{
    plugin: PluginRecord;
    action: Action;
  } | null>(null);
  const [stage, setStage] = useState<PluginPackageInspection | null>(null),
    [probing, setProbing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    installing = useRef(false);
  const filtered = catalog.plugins.filter(
    (plugin) =>
      (!query ||
        `${plugin.name} ${plugin.id}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (source === "all" ||
        (source === "builtin") === isBuiltinPlugin(plugin.id)) &&
      (status === "all" ||
        (status === "abnormal"
          ? plugin.status === "failed" ||
            plugin.health === "degraded" ||
            plugin.health === "failed"
          : plugin.status === status)),
  );
  const current =
    filtered.find((plugin) => plugin.id === selected) ?? filtered[0];
  const candidate = useMemo<PluginRecord | null>(
    () =>
      stage
        ? {
            id: stage.manifest.id,
            name: stage.manifest.name,
            version: stage.manifest.version,
            apiVersion: stage.manifest.apiVersion,
            status: "installed",
            manifest: stage.manifest,
            permissions: stage.manifest.permissions,
            source: "package",
            runtime: "iframe",
            revision: stage.expectedRevision,
            artifactDigest: stage.artifactDigest,
            canRollback: false,
            actions: [],
          }
        : null,
    [stage],
  );
  const upload = async (file: File) => {
    if (!canManage || busy) return;
    setBusy("inspect");
    setError("");
    try {
      setStage(await inspectPluginPackage(file));
      setProbing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  };
  const transition = async () => {
    if (!confirm || busy) return;
    setBusy(confirm.plugin.id);
    setError("");
    try {
      const result = await setPluginStatus(
        confirm.plugin.id,
        confirm.action,
        confirm.plugin.revision ?? 1,
      );
      catalog.update(result);
      toast(`${result.name} · ${statusNames[result.status] ?? result.status}`);
      setConfirm(null);
    } catch (err) {
      setError(errorText(err));
      void catalog.refresh();
    } finally {
      setBusy("");
    }
  };
  const commit = async (nonce: string) => {
    if (!stage || installing.current) return;
    installing.current = true;
    setBusy("install");
    setError("");
    try {
      const installed = await installPlugin(stage, nonce);
      catalog.update(installed);
      setSelected(installed.id);
      setStage(null);
      setProbing(false);
      toast(
        "应用已安装",
        installed.status === "enabled" ? "新版本已生效" : "启用后即可打开",
      );
    } catch (err) {
      setError(errorText(err));
      setProbing(false);
    } finally {
      setBusy("");
      installing.current = false;
    }
  };
  const launch = (plugin: PluginRecord) =>
    open(
      isBuiltinPlugin(plugin.id)
        ? builtinAppIDs[plugin.id]
        : `plugin:${plugin.id}`,
    );
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <ShieldCheck size={18} />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-sm font-semibold">应用管理</h2>
          <p className="m-0 mt-1 text-xs text-muted-foreground">
            {catalog.plugins.length} 个应用 ·{" "}
            {canManage ? "管理工作区应用" : "只读查看"}
          </p>
        </div>
        <button
          className={button}
          aria-label="刷新应用列表"
          disabled={catalog.refreshing}
          onClick={() => void catalog.refresh()}
        >
          <RefreshCw
            size={14}
            className={catalog.refreshing ? "animate-spin" : ""}
          />
        </button>
        {canManage && (
          <button
            className={button}
            disabled={!!busy}
            onClick={() => fileInput.current?.click()}
          >
            <span className="flex items-center gap-1.5">
              <PackagePlus size={14} />
              安装应用
            </span>
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".linkos-plugin,.zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = "";
          }}
        />
      </header>
      {!connected && (
        <div role="status" className="border-b bg-warning/10 px-4 py-2 text-xs">
          实时连接中断，仍可通过 HTTP 管理；状态会定期同步。
        </div>
      )}
      {(catalog.error || error) && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-xs"
        >
          <AlertCircle size={14} />
          <span className="flex-1">{error || catalog.error}</span>
          <button className={button} onClick={() => void catalog.refresh()}>
            重试加载
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <label className="flex min-w-32 flex-1 items-center gap-2 rounded-md border px-2">
          <Search size={13} />
          <input
            aria-label="搜索应用"
            className="min-w-0 flex-1 border-none bg-transparent py-1.5 text-xs outline-none"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称或 ID"
          />
        </label>
        <select
          aria-label="应用来源"
          className={button}
          value={source}
          onChange={(event) => setSource(event.target.value)}
        >
          <option value="all">全部来源</option>
          <option value="builtin">官方应用</option>
          <option value="external">外部插件</option>
        </select>
        <select
          aria-label="应用状态"
          className={button}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">全部状态</option>
          <option value="enabled">已启用</option>
          <option value="disabled">已停用</option>
          <option value="installed">待启用</option>
          <option value="abnormal">异常</option>
          <option value="uninstalled">已卸载</option>
        </select>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto sm:flex-row">
        <div className="shrink-0 border-b p-2 sm:w-64 sm:border-r sm:border-b-0">
          {catalog.loading && (
            <p role="status" className="p-4 text-xs">
              正在加载应用目录…
            </p>
          )}
          {!catalog.loading && !catalog.error && filtered.length === 0 && (
            <p className="p-4 text-xs text-muted-foreground">
              {catalog.plugins.length
                ? "没有符合条件的应用"
                : "没有已安装的应用"}
            </p>
          )}
          {filtered.map((plugin) => (
            <button
              key={plugin.id}
              aria-label={`选择应用 ${plugin.name}`}
              aria-pressed={current?.id === plugin.id}
              className={`mb-1 flex w-full items-center gap-3 rounded-lg border-none p-3 text-left ${current?.id === plugin.id ? "bg-accent" : "bg-transparent hover:bg-muted"}`}
              onClick={() => {
                setSelected(plugin.id);
                setError("");
              }}
            >
              <Package size={20} className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-sm font-medium">
                  {plugin.name}
                </p>
                <p className="m-0 mt-1 text-[11px] text-muted-foreground">
                  {isBuiltinPlugin(plugin.id) ? "官方" : "外部"} ·{" "}
                  {statusNames[plugin.status]}
                </p>
              </div>
            </button>
          ))}
        </div>
        {current && (
          <section className="min-w-0 flex-1 p-5" aria-label="应用详情">
            <div className="flex items-start gap-3">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent">
                <Package size={25} />
              </div>
              <div className="min-w-0">
                <h3 className="m-0 text-lg font-semibold">{current.name}</h3>
                <p className="m-0 mt-1 break-all font-mono text-xs text-muted-foreground">
                  {current.id} · v{current.version}
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full bg-muted px-2 py-1 text-xs">
                {statusNames[current.status]}
              </span>
              <span className="rounded-full bg-muted px-2 py-1 text-xs">
                {isBuiltinPlugin(current.id) ? "官方原生应用" : "隔离 UI 插件"}
              </span>
              <span className="rounded-full bg-muted px-2 py-1 text-xs">
                {isBuiltinPlugin(current.id)
                  ? "随程序交付"
                  : current.signature
                    ? "已验证签名"
                    : "开发未签名"}
              </span>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {current.status === "enabled" && (
                <button className={button} onClick={() => launch(current)}>
                  <span className="flex items-center gap-1.5">
                    打开应用
                    <ArrowUpRight size={13} />
                  </span>
                </button>
              )}
              {canManage && (
                <>
                  {current.status !== "uninstalled" && (
                    <button
                      className={button}
                      disabled={!!busy}
                      onClick={() =>
                        setConfirm({
                          plugin: current,
                          action:
                            current.status === "enabled" ? "disable" : "enable",
                        })
                      }
                    >
                      {current.status === "enabled" ? "停用应用" : "启用应用"}
                    </button>
                  )}
                  {!isBuiltinPlugin(current.id) && (
                    <>
                      <button
                        className={button}
                        disabled={!!busy || !current.canRollback}
                        onClick={() =>
                          setConfirm({ plugin: current, action: "rollback" })
                        }
                      >
                        回滚上一版本
                      </button>
                      {current.status !== "uninstalled" && (
                        <button
                          className={button}
                          disabled={!!busy}
                          onClick={() =>
                            setConfirm({ plugin: current, action: "uninstall" })
                          }
                        >
                          卸载应用
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
            {isBuiltinPlugin(current.id) && (
              <p className="mt-3 text-xs text-muted-foreground">
                版本随 LinkOS 更新。停用保留共享数据，重新启用可恢复使用。
              </p>
            )}
            {current.healthReason && (
              <p role="alert" className="rounded-md bg-warning/10 p-3 text-xs">
                {current.healthReason}
              </p>
            )}
            <dl className="mt-5 space-y-3 text-xs">
              <div>
                <dt className="text-muted-foreground">运行健康</dt>
                <dd className="m-0 mt-1">
                  {current.health === "healthy"
                    ? "资源正常"
                    : current.health === "degraded"
                      ? "需要检查"
                      : "异常"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">网络访问</dt>
                <dd className="m-0 mt-1">禁止外部网络</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">权限范围</dt>
                <dd className="m-0 mt-2 flex flex-wrap gap-1">
                  {current.permissions.map((permission) => (
                    <span
                      key={permission}
                      className="rounded border px-2 py-1 font-mono text-[11px]"
                    >
                      {permission}
                    </span>
                  ))}
                </dd>
              </div>
              {current.previous && (
                <div>
                  <dt className="text-muted-foreground">上一版本</dt>
                  <dd className="m-0 mt-1">
                    {current.previous.manifest.version}
                    {!current.canRollback && " · 缺少完整资源，无法回滚"}
                  </dd>
                </div>
              )}
            </dl>
            {current.id === "runner.exec" && (
              <p className="mt-3 text-xs text-muted-foreground">
                执行引擎状态请查看任务或系统状态；Runner
                未启用时仍可查看历史记录。
              </p>
            )}
          </section>
        )}
      </div>
      {confirm && (
        <Modal
          title={`${confirm.action === "enable" ? "启用" : confirm.action === "disable" ? "停用" : confirm.action === "rollback" ? "回滚" : "卸载"} ${confirm.plugin.name}`}
          busy={!!busy}
          onClose={() => setConfirm(null)}
        >
          <div className="space-y-3 text-sm">
            <p>
              {confirm.action === "enable"
                ? "应用将按以下声明运行："
                : confirm.action === "rollback"
                  ? "恢复上一版本的资源、权限和启用状态。"
                  : "停止应用运行；共享数据和本机草稿保留。"}
            </p>
            <p className="break-all font-mono text-xs">
              {confirm.plugin.permissions.join(" · ") || "无额外权限"}
            </p>
            {error && (
              <p role="alert" className="text-xs">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                className={button}
                disabled={!!busy}
                onClick={() => setConfirm(null)}
              >
                取消
              </button>
              <button
                className={button}
                disabled={!!busy}
                onClick={() => void transition()}
              >
                {busy ? "处理中…" : "确认操作"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {stage && candidate && (
        <Modal
          title={`安装 ${stage.manifest.name}`}
          busy={!!busy}
          onClose={() => {
            setStage(null);
            setProbing(false);
          }}
        >
          <div className="space-y-3 text-sm">
            <p>
              {stage.manifest.id} · v{stage.manifest.version}
            </p>
            <p className="text-xs">
              {stage.trusted ? "受信签名已验证" : "开发环境未签名插件"} ·
              禁止外部网络
            </p>
            <p className="text-xs">
              新增权限：{stage.addedPermissions.join(" · ") || "无"}
            </p>
            <p className="text-xs">
              移除权限：{stage.removedPermissions.join(" · ") || "无"}
            </p>
            {error && (
              <p role="alert" className="text-xs">
                {error}
              </p>
            )}
            {probing ? (
              <div className="h-56 rounded-md border">
                <PluginFrame
                  plugin={candidate}
                  stageId={stage.stageId}
                  onReady={(nonce) => void commit(nonce)}
                />
              </div>
            ) : (
              <button
                className={button}
                disabled={!!busy}
                onClick={() => {
                  setError("");
                  setProbing(true);
                }}
              >
                确认权限，验证并安装
              </button>
            )}
            <p className="text-xs text-muted-foreground">
              验证失败保留当前版本。首次安装完成后需要启用。
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
