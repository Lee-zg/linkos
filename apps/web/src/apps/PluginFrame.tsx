import { useEffect, useRef, useState } from "react";
import type { PluginRecord, PluginViewTicket } from "@linkos/protocol";
import { apiURL, getPluginTicket, pluginRPC } from "../lib/api";
import { enforcePluginFramePolicy } from "../lib/plugin-frame-policy";
import {
  pluginEventMetadata,
  pluginHasPermission,
  rpcByteLength,
} from "../lib/plugin-policy";
import { useWorkspace } from "../lib/workspace";
import { useAppRegistry } from "../os/app-registry";
import { useToast } from "../os/Toaster";
import { useContextMenu } from "../os/ContextMenu";
import { useContextMenuScope } from "../os/ContextMenuScope";
import type { MenuToken } from "../os/context-menu-controller";
import {
  parsePluginMenu,
  pluginMenuAnchor,
  PluginMenuRequests,
} from "../lib/plugin-context-menu";

const TIMEOUT = 5000;
export function PluginFrame({
  plugin,
  stageId,
  onReady,
}: {
  plugin: PluginRecord;
  stageId?: string;
  onReady?: (nonce: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    port = useRef<MessagePort | null>(null);
  const [ticket, setTicket] = useState<PluginViewTicket | null>(null),
    [error, setError] = useState("");
  const [ready, setReady] = useState(false),
    [attempt, setAttempt] = useState(0);
  const { lastEvent, connected } = useWorkspace();
  const { registerCommand } = useAppRegistry();
  const { controller: menus } = useContextMenu();
  const menuScope = useContextMenuScope();
  const toast = useToast(),
    readyCallback = useRef(onReady);
  const subscriptions = useRef(
    new Map<string, { type?: string; resourceId?: string }>(),
  );
  readyCallback.current = onReady;
  useEffect(() => {
    let disposed = false,
      timer: number | undefined,
      handshake: number | undefined;
    let active = 0,
      count = 0,
      since = Date.now();
    type Command = { title: string; dispose: () => void };
    const controllers = new Set<AbortController>(),
      commands = new Map<string, Command>(),
      registrations = new Map<string, object>(),
      menuRequests = new PluginMenuRequests();
    let menuToken: MenuToken | null = null;
    const clearMenu = () => {
      menuRequests.invalidate();
      if (menuToken) menus.dismiss(menuToken);
      menuToken = null;
    };
    const scopeActive = () =>
      !!(
        menuScope &&
        menuScope.owner.kind === "app" &&
        menus.isScopeActive(menuScope) &&
        frame.current?.isConnected
      );
    const fail = (message: string) => {
      if (!disposed) {
        window.clearTimeout(timer);
        window.clearInterval(handshake);
        clearMenu();
        registrations.clear();
        commands.forEach((command) => command.dispose());
        commands.clear();
        controllers.forEach((controller) => controller.abort());
        subscriptions.current.clear();
        setError(message);
        setReady(false);
        port.current?.close();
        port.current = null;
      }
    };
    setTicket(null);
    setError("");
    setReady(false);
    subscriptions.current.clear();
    const receive = async (event: MessageEvent) => {
      const request = event.data;
      if (
        rpcByteLength(request) > 64 * 1024 ||
        request?.type !== "request" ||
        typeof request.id !== "string" ||
        request.id.length > 100 ||
        typeof request.method !== "string"
      )
        return;
      const connection = port.current;
      if (!connection || event.target !== connection) return;
      const connected = () => !disposed && port.current === connection;
      const respond = (value: unknown) => {
        if (connected() && rpcByteLength(value) <= 64 * 1024)
          connection.postMessage(value);
      };
      // Bounded cancellation must work even with every business RPC slot occupied.
      if (request.method === "ui.contextMenu.cancel") {
        const seq = request.params?.seq;
        if (stageId || !Number.isSafeInteger(seq) || seq <= 0) {
          respond({
            type: "response",
            id: request.id,
            error: "无效的菜单取消请求",
          });
        } else {
          if (menuRequests.cancel(seq) && menuToken) {
            menus.dismiss(menuToken);
            menuToken = null;
          }
          respond({ type: "response", id: request.id, result: null });
        }
        return;
      }
      if (Date.now() - since > 1000) {
        since = Date.now();
        count = 0;
      }
      if (++count > 30 || active >= 8) {
        respond({
          type: "response",
          id: request.id,
          error: "插件请求过于频繁",
        });
        return;
      }
      active++;
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), TIMEOUT);
      const params = request.params ?? {};
      let registration: object | undefined;
      try {
        if (stageId) throw new Error("安装候选仅执行握手检查，不开放业务 RPC");
        // Admission precedes asynchronous authorization so older replies cannot
        // resurrect an unregistered command or replace a newer registration.
        if (request.method === "ui.registerCommand") {
          if (
            !pluginHasPermission(plugin, "ui.command") ||
            typeof params.id !== "string" ||
            params.id.length > 100 ||
            !plugin.manifest.contributes?.commands?.includes(params.id)
          )
            throw new Error("命令未包含在已批准声明中");
          if (registrations.size >= 32 && !registrations.has(params.id))
            throw new Error("命令数量超过限制");
          registration = {};
          registrations.set(params.id, registration);
          commands.get(params.id)?.dispose();
          commands.delete(params.id);
          clearMenu();
        }
        if (
          ["ui.notify", "ui.registerCommand", "events.subscribe"].includes(
            request.method,
          )
        ) {
          const permission =
            request.method === "ui.notify"
              ? "ui.notify"
              : request.method === "ui.registerCommand"
                ? "ui.command"
                : `event.subscribe:${params.type ?? "workspace.*"}`;
          if (
            !(await pluginRPC<boolean>(
              plugin,
              "auth.check",
              { permission },
              controller.signal,
            ))
          )
            throw new Error("插件权限或启用状态已改变");
          if (!connected()) return;
        }
        let result: unknown;
        switch (request.method) {
          case "ui.notify":
            if (!pluginHasPermission(plugin, "ui.notify"))
              throw new Error("未声明通知权限");
            toast(
              String(params.title ?? "插件通知").slice(0, 100),
              String(params.body ?? "").slice(0, 2000),
            );
            result = null;
            break;
          case "ui.registerCommand": {
            if (
              !connected() ||
              controller.signal.aborted ||
              registrations.get(params.id) !== registration
            ) {
              result = null;
              break;
            }
            const command: Command = {
              title: String(params.title ?? params.id).slice(0, 100),
              dispose: () => {},
            };
            command.dispose = registerCommand(plugin.id, {
              id: params.id,
              title: command.title,
              run: async () => {
                const allowed = await pluginRPC<boolean>(plugin, "auth.check", {
                  permission: "ui.command",
                }).catch(() => false);
                if (
                  allowed &&
                  connected() &&
                  commands.get(params.id) === command
                )
                  connection.postMessage({ type: "command", id: params.id });
              },
            });
            commands.set(params.id, command);
            result = null;
            break;
          }
          case "ui.unregisterCommand":
            registrations.delete(params.id);
            commands.get(params.id)?.dispose();
            commands.delete(params.id);
            clearMenu();
            result = null;
            break;
          case "ui.contextMenu.open": {
            const element = frame.current;
            if (!element) {
              result = { token: null };
              break;
            }
            const value = parsePluginMenu(params, commands, {
              width: element.clientWidth,
              height: element.clientHeight,
            });
            if (
              !connected() ||
              !scopeActive() ||
              document.activeElement !== element ||
              !pluginHasPermission(plugin, "ui.command")
            ) {
              result = { token: null };
              break;
            }
            const pending = menuRequests.begin(value.seq);
            if (!pending) {
              result = { token: null };
              break;
            }
            // Admission supersedes every pending gesture, even without our own
            // visible token. begin already replaced our old ticket; clearMenu
            // would invalidate this new one. Old onClose cancels only its seq.
            menus.dismiss();
            menuToken = null;
            const epoch = menus.epoch;
            const referenced = new Map(
              value.groups.flatMap((group) =>
                group.items.map(
                  (item) =>
                    [item.commandId, commands.get(item.commandId)!] as const,
                ),
              ),
            );
            const valid = () =>
              connected() &&
              menuRequests.isCurrent(pending) &&
              scopeActive() &&
              frame.current === element &&
              [...referenced].every(
                ([id, command]) => commands.get(id) === command,
              );
            const allowed = await pluginRPC<boolean>(
              plugin,
              "auth.check",
              { permission: "ui.command" },
              controller.signal,
            );
            if (
              !allowed ||
              controller.signal.aborted ||
              !valid() ||
              menus.epoch !== epoch ||
              document.activeElement !== element
            ) {
              menuRequests.cancel(value.seq);
              result = { token: null };
              break;
            }
            const wireToken = crypto.randomUUID();
            const reference = { seq: value.seq, token: wireToken };
            const notifyClosed = (restoreFocus: boolean) => {
              if (connected())
                connection.postMessage({
                  type: "context-menu.closed",
                  ...reference,
                  restoreFocus,
                });
            };
            menuToken = menus.open(menuScope!, {
              anchor: pluginMenuAnchor(
                value.anchor,
                element.getBoundingClientRect(),
                element,
              ),
              target: null,
              content: value.groups.map((group) => ({
                id: group.id,
                items: group.items.map((item) => ({
                  id: item.commandId,
                  label: referenced.get(item.commandId)!.title,
                  disabled: item.disabled,
                  restoreFocus: false,
                  onClick: () => {
                    const actionEpoch = menus.epoch;
                    const auth = new AbortController();
                    controllers.add(auth);
                    const timeout = setTimeout(() => auth.abort(), TIMEOUT);
                    void pluginRPC<boolean>(
                      plugin,
                      "auth.check",
                      { permission: "ui.command" },
                      auth.signal,
                    )
                      .then((allowed) => {
                        if (
                          allowed &&
                          !auth.signal.aborted &&
                          valid() &&
                          menus.epoch === actionEpoch
                        ) {
                          connection.postMessage({
                            type: "command",
                            id: item.commandId,
                            contextMenu: reference,
                          });
                          menuRequests.cancel(value.seq);
                        } else notifyClosed(false);
                      })
                      .catch(() => notifyClosed(false))
                      .finally(() => {
                        clearTimeout(timeout);
                        controllers.delete(auth);
                      });
                  },
                })),
              })),
              onClose: (token, reason) => {
                if (menuToken === token) menuToken = null;
                if (reason !== "activate") {
                  menuRequests.cancel(value.seq);
                  notifyClosed(reason === "close");
                }
              },
            });
            if (!menuToken) menuRequests.cancel(value.seq);
            result = { token: menuToken ? wireToken : null };
            break;
          }
          case "events.subscribe": {
            const type =
              typeof params.type === "string" ? params.type : "workspace.*";
            if (!pluginHasPermission(plugin, `event.subscribe:${type}`))
              throw new Error("未声明对应事件订阅权限");
            if (subscriptions.current.size >= 32)
              throw new Error("订阅数量超过限制");
            const id = crypto.randomUUID();
            subscriptions.current.set(id, {
              type,
              resourceId:
                typeof params.resourceId === "string"
                  ? params.resourceId
                  : undefined,
            });
            result = id;
            break;
          }
          case "events.unsubscribe":
            subscriptions.current.delete(params.id);
            result = null;
            break;
          default:
            result = await pluginRPC(
              plugin,
              request.method,
              params,
              controller.signal,
            );
        }
        respond({ type: "response", id: request.id, result });
      } catch (err) {
        respond({
          type: "response",
          id: request.id,
          error: err instanceof Error ? err.message : "RPC 失败",
        });
      } finally {
        // Failed/aborted admission releases only its own reservation, never a
        // newer registration that is still awaiting authorization.
        if (
          registration &&
          registrations.get(params.id) === registration &&
          !commands.has(params.id)
        )
          registrations.delete(params.id);
        clearTimeout(timeout);
        controllers.delete(controller);
        active--;
      }
    };
    let issued: PluginViewTicket | undefined;
    const initialize = () => {
      if (!issued || disposed || port.current) return;
      frame.current?.contentWindow?.postMessage(
        {
          type: "linkos.host.init",
          nonce: issued.nonce,
          pluginId: plugin.id,
          version: plugin.version,
          protocol: "1.0",
          permissions: plugin.permissions,
        },
        "*",
      );
    };
    const onMessage = (event: MessageEvent) => {
      if (
        !issued ||
        disposed ||
        port.current ||
        event.source !== frame.current?.contentWindow ||
        event.origin !== "null" ||
        rpcByteLength(event.data) > 64 * 1024
      )
        return;
      const data = event.data;
      if (
        data?.type !== "linkos.plugin.ready" ||
        data.nonce !== issued.nonce ||
        data.pluginId !== plugin.id ||
        data.version !== plugin.version
      )
        return;
      if (data.protocol !== "1.0") {
        fail("插件通信协议不兼容");
        return;
      }
      window.clearTimeout(timer);
      window.clearInterval(handshake);
      const channel = new MessageChannel();
      port.current = channel.port1;
      channel.port1.onmessage = receive;
      channel.port1.start();
      frame.current?.contentWindow?.postMessage(
        { type: "linkos.host.connect", nonce: issued.nonce, protocol: "1.0" },
        "*",
        [channel.port2],
      );
      setReady(true);
      readyCallback.current?.(issued.nonce);
    };
    window.addEventListener("message", onMessage);
    const load = async () => {
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), TIMEOUT);
      try {
        enforcePluginFramePolicy();
        const value = await getPluginTicket(
          plugin.id,
          stageId,
          controller.signal,
        );
        if (disposed) return;
        const response = await fetch(apiURL(value.src), {
          method: "HEAD",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`插件资源加载失败（${response.status}）`);
        if (disposed) return;
        issued = value;
        setTicket(value);
        timer = window.setTimeout(
          () => fail("插件握手超时，界面未能启动"),
          TIMEOUT,
        );
        handshake = window.setInterval(initialize, 200);
      } catch (err) {
        fail(err instanceof Error ? err.message : "插件加载失败");
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
    };
    void load();
    return () => {
      clearMenu();
      disposed = true;
      window.clearTimeout(timer);
      window.clearInterval(handshake);
      window.removeEventListener("message", onMessage);
      port.current?.close();
      port.current = null;
      controllers.forEach((value) => value.abort());
      registrations.clear();
      commands.forEach((command) => command.dispose());
      subscriptions.current.clear();
    };
  }, [
    plugin.id,
    plugin.version,
    plugin.revision,
    plugin.artifactDigest,
    stageId,
    attempt,
    registerCommand,
    toast,
    menus,
    menuScope,
  ]);
  useEffect(() => {
    if (!lastEvent || !ready || stageId) return;
    let disposed = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    const metadata = pluginEventMetadata(lastEvent);
    for (const [id, filter] of subscriptions.current) {
      const type = filter.type ?? "workspace.*";
      if (
        type !== "workspace.*" &&
        type !== metadata.type &&
        !(type.endsWith("*") && metadata.type.startsWith(type.slice(0, -1)))
      )
        continue;
      if (filter.resourceId && filter.resourceId !== metadata.resourceId)
        continue;
      void pluginRPC<boolean>(
        plugin,
        "events.check",
        {
          type: metadata.type,
          resourceId: metadata.resourceId,
          eventId: metadata.eventId,
        },
        controller.signal,
      )
        .then((allowed) => {
          if (allowed && !disposed && subscriptions.current.has(id))
            port.current?.postMessage({
              type: "event",
              subscriptionId: id,
              event: metadata,
            });
        })
        .catch(() => undefined);
    }
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [lastEvent, ready, stageId, plugin]);
  return (
    <div className="relative flex h-full min-h-48 flex-col bg-background">
      {!connected && ready && (
        <p className="m-0 border-b px-3 py-1 text-xs text-muted-foreground">
          实时连接中断，事件同步暂不可用。
        </p>
      )}
      {ticket && !error && (
        <iframe
          ref={frame}
          title={`${plugin.name} 插件沙箱`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={apiURL(ticket.src)}
          onError={() => setError("插件资源加载失败")}
          className="min-h-0 flex-1 border-none"
        />
      )}
      {!ready && !error && (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          正在验证并启动应用…
        </p>
      )}
      {error && (
        <div role="alert" className="m-auto max-w-md p-6 text-sm">
          <p>{error}</p>
          <button
            className="rounded-md border px-3 py-1.5"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重新启动
          </button>
        </div>
      )}
    </div>
  );
}
