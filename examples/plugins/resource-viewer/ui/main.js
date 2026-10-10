import { connectPlugin } from "./linkos-sdk.js";
const manifest = {
  id: "example.resource-viewer",
  version: "1.0.0",
  apiVersion: "1.0",
};
const status = document.querySelector("#status");
try {
  const context = await connectPlugin(manifest);
  async function refresh() {
    try {
      const user = await context.auth.currentUser();
      document.querySelector("#user").textContent =
        `${user.displayName} · 只读访问`;
      const list = document.querySelector("#resources");
      list.replaceChildren();
      for await (const resource of context.resources.list({})) {
        const item = document.createElement("li");
        item.textContent = `${resource.name} · ${resource.type}`;
        list.append(item);
      }
      status.textContent = "资源已加载";
    } catch (error) {
      status.textContent = error.message;
    }
  }
  document.querySelector("#refresh").onclick = refresh;
  const command = context.ui.registerCommand({
    id: "refresh",
    title: "刷新资源阅读器",
    run: refresh,
  });
  const subscription = context.events.subscribe(
    { type: "resources.changed" },
    refresh,
  );
  window.addEventListener(
    "pagehide",
    () => {
      subscription();
      command();
      context.dispose();
    },
    { once: true },
  );
  await refresh();
} catch (error) {
  status.textContent = error.message;
}
