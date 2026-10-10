import { apiURL } from "./api";
// Child connect-src alone does not prevent an iframe navigating itself away.
export function enforcePluginFramePolicy() {
  const source = new URL(
    apiURL("/api/v1/plugin-views/"),
    window.location.origin,
  ).href;
  let meta = document.querySelector<HTMLMetaElement>(
    "meta[data-linkos-plugin-frames]",
  );
  if (meta) {
    if (meta.content !== `frame-src ${source}`)
      throw new Error("网关已切换，请刷新页面后打开插件");
    return;
  }
  meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = `frame-src ${source}`;
  meta.dataset.linkosPluginFrames = "true";
  document.head.append(meta);
}
