import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import type { PluginRecord } from "@linkos/protocol";
import { getGatewayBase } from "../lib/api";

const MAX_RPC_BYTES = 64 * 1024;
const RPC_TIMEOUT_MS = 5000;

class PluginErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* isolated plugin failure */ }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function buildFallbackSrcDoc(plugin: PluginRecord) {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>body{margin:0;padding:14px;font:12px ui-monospace,monospace;color:#26302b;background:#f6f7f5}b{display:block;margin-bottom:6px}small{color:#68736c}</style><b>${escapeHTML(plugin.name)}</b><small>${escapeHTML(plugin.id)} · API ${escapeHTML(plugin.apiVersion)}</small>`;
}

export function PluginFrame({ plugin }: { plugin: PluginRecord }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [useFallback, setUseFallback] = useState(false);

  const contentURL = useMemo(() => {
    const base = getGatewayBase();
    const entry = plugin.manifest?.entry?.ui;
    if (!entry) return "";
    return `${base}/api/v1/plugins/${encodeURIComponent(plugin.id)}/content/${entry.split("/").map(encodeURIComponent).join("/")}`;
  }, [plugin.id, plugin.manifest?.entry?.ui]);

  const fallbackSrcDoc = useMemo(() => buildFallbackSrcDoc(plugin), [plugin]);

  useEffect(() => {
    setUseFallback(false);
    setStatus("loading");
  }, [plugin.id]);

  useEffect(() => {
    const id = crypto.randomUUID();
    const timer = window.setTimeout(() => setStatus("failed"), RPC_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!useFallback && event.origin !== "null") return;
      if (useFallback && event.origin !== window.location.origin && event.origin !== "null") return;
      let size = MAX_RPC_BYTES + 1;
      try { size = JSON.stringify(event.data).length; } catch { return; }
      if (size > MAX_RPC_BYTES) return;
      if (event.data?.type === "linkos.plugin.ready" && event.data.id === id) { window.clearTimeout(timer); setStatus("ready"); }
    };
    window.addEventListener("message", onMessage);
    const init = () => frameRef.current?.contentWindow?.postMessage({ type: "linkos.host.init", id, apiVersion: "1.0", permissions: plugin.permissions }, "*");
    const frame = frameRef.current;
    frame?.addEventListener("load", init);
    const loadTimer = window.setTimeout(init, 50);
    return () => { window.clearTimeout(timer); window.clearTimeout(loadTimer); frame?.removeEventListener("load", init); window.removeEventListener("message", onMessage); };
  }, [plugin, useFallback]);

  const src = useFallback || !contentURL ? undefined : contentURL;
  const srcDoc = useFallback || !contentURL ? fallbackSrcDoc : undefined;

  return <PluginErrorBoundary fallback={<p className="p-3 text-xs text-destructive-foreground">插件视图已隔离并停止。</p>}><div className="relative h-48 overflow-hidden rounded-md border bg-background"><iframe ref={frameRef} title={`${plugin.name} 插件沙箱`} sandbox="allow-scripts" referrerPolicy="no-referrer" src={src} srcDoc={srcDoc} onError={() => { if (!useFallback) setUseFallback(true); }} className="h-full w-full border-none" />{status !== "ready" && <span className={`absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] ${status === "failed" ? "bg-destructive/10 text-destructive-foreground" : "bg-muted text-muted-foreground"}`}>{status === "failed" ? "启动失败" : "启动中"}</span>}</div></PluginErrorBoundary>;
}

function escapeHTML(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
