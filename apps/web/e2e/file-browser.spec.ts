import { expect, test as base, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

type AuthState = Awaited<ReturnType<BrowserContext["storageState"]>>;
// Contract tests reuse a real authenticated session per worker; they do not test login
// and should not exhaust the disposable gateway's session rate limit.
const test = base.extend<{}, { authState: AuthState }>({
  authState: [async ({ browser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(process.env.LINKOS_E2E_BASE_URL ?? "http://127.0.0.1:5173");
    await page.getByLabel("显示名").fill("F3 contract tester");
    await page.getByLabel(/口令/).fill(process.env.LINKOS_E2E_ADMIN_PASSCODE ?? "linkos-admin");
    const loginButton = page.getByRole("button", { name: "登录进入" });
    await expect(loginButton).toBeEnabled();
    await loginButton.click({ force: true });
    await expect(page.locator(".dock-connection"), "Gateway login is required for the real authenticated contract fixture").toHaveAttribute("aria-label", "已连接工作区");
    const state = await context.storageState();
    await context.close();
    await use(state);
  }, { scope: "worker" }],
  storageState: async ({ authState }, use) => { await use(authState); },
  page: async ({ page }, use) => {
    // Other agents edit this live dev server during the run. Keep Vite HMR from
    // reloading an in-progress interaction; application WebSockets remain real.
    await page.routeWebSocket(url => !url.pathname.startsWith("/api/v1/ws"), () => {});
    await use(page);
  },
});

const resource = (id: string, name: string, type = "folder", extra = {}) => ({
  id, name, type, workspaceId: "demo", parentId: "", canRead: true, canWrite: true, canCreateChild: true,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra,
});
const listing = (items: ReturnType<typeof resource>[], extra = {}) => ({
  items, total: items.length, ancestors: [], canRead: true, canWrite: true, canCreateChild: true, ...extra,
});
async function openFiles(page: Page) {
  await page.goto("/");
  await expect(page.locator(".dock-connection")).toHaveAttribute("aria-label", "已连接工作区");
  const icon = page.getByText("文件", { exact: true }).first();
  if ((page.viewportSize()?.width ?? 1024) < 768) await icon.click(); else await icon.dblclick();
  return page.getByRole("dialog", { name: "文件", exact: true });
}
async function openFolder(page: Page, name: string) {
  const item = page.locator('[data-resource-id]').filter({ hasText: name }).first();
  if ((page.viewportSize()?.width ?? 1024) < 768) await item.click(); else await item.dblclick();
}
async function chooseLocation(page: Page, name: string) {
  const files = page.getByRole("dialog", { name: "文件", exact: true });
  const toggle = files.getByRole("button", { name: "文件位置", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await files.getByRole("button", { name, exact: true }).click();
}

async function mockPersonalLocations(page: Page) {
  await page.route("**/api/v1/file-preferences", route => route.fulfill({ json: {
    downloadsId: "downloads", inboxId: "personal", trashId: "trash", outgoingId: "outgoing", receiveFolderId: "downloads",
  } }));
}

test("server ancestors drive real path and up navigation, not visit history", async ({ page }) => {
  await page.route("**/api/v1/resources?*", async route => {
    const parent = new URL(route.request().url()).searchParams.get("parentId");
    await route.fulfill({ json: parent === "child" ? listing([], { ancestors: [{ id: "parent", name: "真正父目录" }, { id: "child", name: "子目录" }] }) : listing([resource("child", "子目录")]) });
  });
  const files = await openFiles(page);
  // Use existing text for the initial RED so it fails on missing path rather than new row selectors.
  const child = files.getByText("子目录", { exact: true });
  if ((page.viewportSize()?.width ?? 1024) < 768) await child.click(); else await child.dblclick();
  await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("真正父目录");
  await expect(files.getByRole("button", { name: "上一级", exact: true })).toBeEnabled();
  const request = page.waitForRequest(req => new URL(req.url()).searchParams.get("parentId") === "parent");
  await files.getByRole("button", { name: "上一级", exact: true }).click();
  await request;
});

for (const parentWritable of [false, true]) test(`location and object capabilities disable mutation commands (parent write ${parentWritable})`, async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("locked", "只读文件", "file", { canWrite: false })], { canWrite: parentWritable, canCreateChild: false }) }));
  const files = await openFiles(page);
  await expect(files.getByText("只读文件", { exact: true })).toBeVisible();
  await expect(files.getByRole("button", { name: "新建文件夹", exact: true })).toBeDisabled();
  await expect(files.getByRole("button", { name: "上传文件", exact: true })).toBeDisabled();
  await files.getByRole("button", { name: "更多操作 只读文件", exact: true }).click();
  for (const name of ["重命名", "移到废纸篓", "移动到..."]) await expect(page.getByRole("menuitem", { name, exact: true })).toBeDisabled();
});

test("grid paginates without client reordering and keeps search across views", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: params.has("cursor") ? listing([resource("a", "A server last", "file")], { total: 2 }) : listing([resource("z", "Z server first", "file")], { nextCursor: "page2", total: 2 }) });
  });
  const files = await openFiles(page);
  await files.getByRole("button", { name: "图标视图" }).click();
  await expect(files.getByRole("button", { name: "加载更多", exact: true })).toBeVisible();
  await files.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(files.getByRole("gridcell")).toHaveText([/Z server first/, /A server last/]);
  await files.getByRole("textbox", { name: "搜索文件" }).fill("server");
  await files.getByRole("button", { name: "列表视图" }).click();
  await expect(files.getByRole("textbox", { name: "搜索文件" })).toHaveValue("server");
});

test("keyboard rename is a portal modal with input exemption and focus restoration", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("edit", "可编辑", "file")]) }));
  const files = await openFiles(page);
  const item = files.getByRole("row", { name: "可编辑", exact: true });
  await item.click();
  await item.press("F2");
  const dialog = page.getByRole("dialog", { name: "重命名", exact: true });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(files.getByRole("dialog", { name: "重命名", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "名称", exact: true })).toBeFocused();
  await dialog.getByRole("textbox", { name: "名称", exact: true }).press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "重命名", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await dialog.getByRole("textbox", { name: "名称", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "名称", exact: true }).fill("保留输入");
  await dialog.getByRole("textbox", { name: "名称", exact: true }).press("Delete");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "名称", exact: true }).press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(item).toBeFocused();
});

test("portal backgrounds and inputs cannot inherit the Files menu", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("probe", "菜单文件", "file")]) }));
  const files = await openFiles(page);
  await files.getByRole("button", { name: "更多操作 菜单文件", exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名", exact: true });
  for (const target of [dialog, dialog.getByRole("textbox")]) {
    expect(await target.evaluate(el => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(false);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await target.press("Shift+F10");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  await dialog.getByRole("textbox").fill("输入保留");
  await dialog.getByRole("textbox").press("Delete");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("right click selection snapshots replace old selections and keyboard companions do not reopen", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("old", "原选择", "file"), resource("new", "新选择", "file")]) }));
  let operation: unknown;
  await page.route("**/api/v1/file-operations", route => { operation = route.request().postDataJSON(); return route.fulfill({ json: { items: [] } }); });
  const files = await openFiles(page);
  const previous = files.locator('[data-resource-id="old"]');
  const next = files.locator('[data-resource-id="new"]');
  await previous.click();
  await next.click({ button: "right" });
  await expect(next).toHaveAttribute("aria-selected", "true");
  await expect(previous).toHaveAttribute("aria-selected", "false");
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  const content = files.getByLabel("文件内容", { exact: true });
  await content.press("Shift+F10");
  await page.keyboard.press("ArrowDown");
  const focused = page.getByRole("menuitem", { name: "粘贴项目", exact: true });
  await expect(focused).toBeFocused();
  await content.dispatchEvent("contextmenu", { button: 0, clientX: 0, clientY: 0 });
  await expect(focused).toBeFocused();
  await focused.click();
  await expect.poll(() => operation).toEqual({ action: "copy", ids: ["new"], parentId: "" });
  await next.focus();
  for (const key of ["F10", "ContextMenu"]) {
    const composing = await next.evaluate((el, key) => {
      let reachedTarget = false;
      const listener = () => { reachedTarget = true; };
      el.addEventListener("keydown", listener);
      const allowed = el.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: key === "F10", isComposing: true, bubbles: true, cancelable: true }));
      el.removeEventListener("keydown", listener);
      return { allowed, reachedTarget };
    }, key);
    expect(composing).toEqual({ allowed: true, reachedTarget: true });
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  // IME keys pass through, but the browser's native context menu is still canceled separately.
  expect(await next.evaluate(el => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(false);
  await expect(page.getByRole("menuitem", { name: "下载", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(next).toBeFocused();
});

test("recent is queried from server and legacy upload history is explicitly local", async ({ page }) => {
  let recent = false;
  await page.addInitScript(() => localStorage.setItem("linkos.uploaded-files", JSON.stringify([{ resourceId: "legacy", name: "旧记录", size: 1, uploadedAt: "2026-01-01T00:00:00Z" }])));
  await page.route("**/api/v1/resources?*", route => {
    recent = new URL(route.request().url()).searchParams.get("recent") === "true";
    return route.fulfill({ json: listing(recent ? [resource("remote", "服务端最近", "file")] : []) });
  });
  const files = await openFiles(page);
  await chooseLocation(page, "最近文件");
  await expect(files.getByText("服务端最近", { exact: true })).toBeVisible();
  expect(recent).toBe(true);
  await chooseLocation(page, "本机历史");
  await expect(files.getByText("旧记录", { exact: true })).toBeVisible();
});

test("move picker browses paginated folders, rejects self and surfaces failures", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => {
    const params = new URL(route.request().url()).searchParams;
    const parent = params.get("parentId");
    const data = parent === "target" ? listing([resource("nested", "嵌套目标")], { ancestors: [{ id: "target", name: "目标" }] }) : listing([resource("source", "源目录"), resource("target", "目标")], { nextCursor: params.has("cursor") ? undefined : "page2" });
    return route.fulfill({ json: data });
  });
  await page.route("**/api/v1/resources/source", route => route.fulfill({ status: 403, json: { error: "forbidden", message: "禁止移动测试" } }));
  const files = await openFiles(page);
  await files.getByRole("button", { name: "更多操作 源目录", exact: true }).click();
  await page.getByRole("menuitem", { name: "移动到...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "移动到", exact: true });
  await expect(dialog.getByRole("button", { name: "源目录", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "加载更多", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "目标", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "嵌套目标", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "移动", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("禁止移动测试");
});

test("stale cursor reloads first page instead of stranding the browser", async ({ page }) => {
  let reloaded = false;
  await page.route("**/api/v1/resources?*", route => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      reloaded = true;
      return route.fulfill({ status: 409, json: { error: "cursor_stale", message: "stale cursor" } });
    }
    return route.fulfill({ json: listing([resource("one", reloaded ? "已恢复" : "第一页")], { nextCursor: reloaded ? undefined : "stale" }) });
  });
  const files = await openFiles(page);
  await files.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(files.getByText("已恢复", { exact: true })).toBeVisible();
});

test("shared resource notifications recover a missing folder to its accessible ancestor", async ({ page }) => {
  let socket!: WebSocketRoute;
  let removed = false;
  await page.routeWebSocket("**/api/v1/ws?*", ws => { socket = ws; });
  await page.route("**/api/v1/resources?*", route => {
    const parent = new URL(route.request().url()).searchParams.get("parentId");
    if (parent === "child" && removed) return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    return route.fulfill({ json: parent === "child" ? listing([], { ancestors: [{ id: "parent", name: "幸存父目录" }, { id: "child", name: "消失目录" }] }) : listing(parent === "parent" ? [resource("survivor", "幸存文件", "file")] : [resource("child", "消失目录")], { ancestors: parent === "parent" ? [{ id: "parent", name: "幸存父目录" }] : [] }) });
  });
  const files = await openFiles(page);
  const child = files.getByText("消失目录", { exact: true });
  if ((page.viewportSize()?.width ?? 1024) < 768) await child.click(); else await child.dblclick();
  await expect(files.getByText("此文件夹为空", { exact: true })).toBeVisible();
  removed = true;
  socket.send(JSON.stringify({ type: "resources.changed", eventId: "removed", seq: 1, payload: {} }));
  await expect(files.getByText("幸存文件", { exact: true })).toBeVisible();
  await expect(files.getByRole("status")).toContainText("已返回");
});

test("resource refresh preserves open name form and changed path", async ({ page }) => {
  let socket!: WebSocketRoute;
  let moved = false;
  await page.routeWebSocket("**/api/v1/ws?*", ws => { socket = ws; });
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("child", "内部文件", "file")], { ancestors: moved ? [{ id: "moved", name: "移动后的父目录" }] : [] }) }));
  const files = await openFiles(page);
  await files.getByRole("button", { name: "新建文件夹", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建文件夹", exact: true });
  await dialog.getByRole("textbox").fill("未提交名称");
  moved = true;
  socket.send(JSON.stringify({ type: "resources.changed", eventId: "moved", seq: 1, payload: {} }));
  await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("移动后的父目录");
  await expect(dialog.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("未提交名称");
});

test("delete errors stay visible and submission cannot dismiss the modal", async ({ page }) => {
  await mockPersonalLocations(page);
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("delete", "待删除", "file")]) }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/resources/delete?*", async route => { await gate; await route.fulfill({ status: 403, json: { error: "FORBIDDEN", message: "无法删除测试" } }); });
  const files = await openFiles(page);
  await chooseLocation(page, "废纸篓");
  await files.getByRole("button", { name: "更多操作 待删除", exact: true }).click();
  await page.getByRole("menuitem", { name: "永久删除", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "确认删除" });
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  release();
  await expect(dialog.getByRole("alert")).toContainText("无法删除测试");
});

test("recent then shared keeps back history synchronized with the displayed directory", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: params.get("parentId") === "inside" ? listing([], { ancestors: [{ id: "inside", name: "进入目录" }] }) : listing([resource("inside", "进入目录")]) });
  });
  const files = await openFiles(page);
  await openFolder(page, "进入目录");
  await expect(files.getByText("此文件夹为空", { exact: true })).toBeVisible();
  await chooseLocation(page, "最近文件");
  await chooseLocation(page, "共享文件");
  await expect(files.locator('[data-resource-id="inside"]')).toBeVisible();
  await files.getByRole("button", { name: "后退", exact: true }).click();
  await expect(files.getByText("此文件夹为空", { exact: true })).toBeVisible();
  await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("进入目录");
});

test("offline double click does not download cached files", async ({ page }) => {
  let socket!: WebSocketRoute;
  let downloads = 0;
  await page.routeWebSocket("**/api/v1/ws?*", ws => { socket = ws; });
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("offline", "离线文件", "file")]) }));
  await page.route("**/api/v1/files/offline/content", route => { downloads++; return route.fulfill({ body: "unexpected" }); });
  const files = await openFiles(page);
  await expect(files.getByText("离线文件", { exact: true })).toBeVisible();
  await socket.close();
  await expect(files.getByRole("alert")).toContainText("离线");
  await files.getByText("离线文件", { exact: true }).dblclick();
  await files.getByRole("button", { name: "更多操作 离线文件", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "下载", exact: true })).toBeDisabled();
  expect(downloads).toBe(0);
});

test("shared socket bursts and snapshot recovery refresh without another socket", async ({ page }) => {
  let socket!: WebSocketRoute;
  let sockets = 0;
  let lists = 0;
  let name = "初始内容";
  await page.routeWebSocket("**/api/v1/ws?*", ws => { socket = ws; sockets++; });
  await page.route("**/api/v1/resources?*", route => { lists++; return route.fulfill({ json: listing([resource("event", name, "file")]) }); });
  const files = await openFiles(page);
  await expect(files.getByText("初始内容", { exact: true })).toBeVisible();
  const baseline = lists;
  name = "合并刷新";
  for (let seq = 1; seq <= 5; seq++) socket.send(JSON.stringify({ type: "resources.changed", eventId: `burst-${seq}`, seq, payload: {} }));
  await expect(files.getByText("合并刷新", { exact: true })).toBeVisible();
  expect(lists).toBe(baseline + 1);
  name = "快照恢复";
  socket.send(JSON.stringify({ type: "workspace.snapshot.required", payload: { currentEventSeq: 10 } }));
  await expect(files.getByText("快照恢复", { exact: true })).toBeVisible();
  expect(sockets).toBe(1);
  name = "重新连接";
  await socket.close();
  await expect.poll(() => sockets).toBe(2);
  await expect(files.getByText("重新连接", { exact: true })).toBeVisible();
});

test("late directory responses cannot overwrite navigation or search", async ({ page }) => {
  let release!: () => void;
  let blockRoot = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/resources?*", async route => {
    const params = new URL(route.request().url()).searchParams;
    if (!params.get("parentId") && blockRoot) await gate;
    await route.fulfill({ json: params.get("parentId") === "new" ? listing([resource("result", params.get("q") ? "搜索结果" : "新目录文件", "file")], { ancestors: [{ id: "new", name: "新目录" }] }) : listing([resource("new", "新目录")]) });
  });
  const files = await openFiles(page);
  await expect(files.locator('[data-resource-id="new"]')).toBeVisible();
  blockRoot = true;
  const requested = page.waitForRequest(req => req.url().includes("/resources?") && !new URL(req.url()).searchParams.get("parentId"));
  await files.getByRole("button", { name: "刷新", exact: true }).click();
  await requested;
  await openFolder(page, "新目录");
  await files.getByRole("textbox", { name: "搜索文件" }).fill("查询");
  await expect(files.getByText("搜索结果", { exact: true })).toBeVisible();
  const lateResponse = page.waitForResponse(response => response.url().includes("/resources?") && !new URL(response.url()).searchParams.get("parentId"));
  release();
  await (await lateResponse).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("新目录");
  await expect(files.getByRole("textbox", { name: "搜索文件" })).toHaveValue("查询");
  await expect(files.getByText("搜索结果", { exact: true })).toBeVisible();
});

test("upload completion refreshes current navigation and retains one batch destination", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const destinations: string[] = [];
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/v1/resources?*", route => {
    const parent = new URL(route.request().url()).searchParams.get("parentId");
    return route.fulfill({ json: parent === "target" ? listing([resource("child", "目标内容", "file")], { ancestors: [{ id: "target", name: "目标目录" }] }) : listing([resource("target", "目标目录")]) });
  });
  await page.route("**/api/v1/uploads", route => {
    destinations.push(route.request().postDataJSON().parentId);
    started();
    return route.fulfill({ json: { id: `upload-${destinations.length}`, chunkSize: 8, totalParts: 1, receivedParts: [], status: "created" } });
  });
  await page.route("**/api/v1/uploads/*/parts/*", route => route.fulfill({ json: { status: "received" } }));
  await page.route("**/api/v1/uploads/*/complete", async route => {
    await gate;
    await route.fulfill({ json: { entryId: `entry-${destinations.length}`, resourceId: "blob", name: "已完成" } });
  });
  const files = await openFiles(page);
  await expect(files.getByRole("button", { name: "上传文件", exact: true })).toBeEnabled();
  await files.getByLabel("选择要上传的文件").setInputFiles([
    { name: "one.txt", mimeType: "text/plain", buffer: Buffer.from("one") },
    { name: "two.txt", mimeType: "text/plain", buffer: Buffer.from("two") },
  ]);
  await firstStarted;
  await openFolder(page, "目标目录");
  await expect(files.getByText("目标内容", { exact: true })).toBeVisible();
  release();
  await expect.poll(() => destinations.length).toBe(2);
  await expect(page.getByText("two.txt 上传完成", { exact: true })).toBeVisible();
  expect(destinations).toEqual(["", ""]);
  await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("目标目录");
  await expect(files.getByText("目标内容", { exact: true })).toBeVisible();
});

test("Enter, Shift F10 and Delete share the object commands", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("parentId") === "keyboard" ? listing([resource("keyfile", "键盘文件", "file")], { ancestors: [{ id: "keyboard", name: "键盘目录" }] }) : listing([resource("keyboard", "键盘目录")]) }));
  const files = await openFiles(page);
  const folder = files.getByRole("row", { name: "键盘目录", exact: true });
  await folder.focus();
  await folder.press("Enter");
  await expect(page.getByRole("dialog", { name: "重命名", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(folder).toBeFocused();
  await folder.press("Control+ArrowDown");
  const file = files.getByRole("row", { name: "键盘文件", exact: true });
  await file.focus();
  await file.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "下载", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(file).toBeFocused();
  let operation: unknown;
  await page.route("**/api/v1/file-operations", route => { operation = route.request().postDataJSON(); return route.fulfill({ json: { items: [] } }); });
  await file.press("Delete");
  await expect.poll(() => operation).toEqual({ action: "trash", ids: ["keyfile"] });
  await expect(page.getByRole("alertdialog", { name: "确认删除" })).toHaveCount(0);
});

test("information resolves the real resource path rather than visit history", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("parentId") === "real-parent" ? listing([], { ancestors: [{ id: "real-parent", name: "真实父目录" }] }) : listing([resource("info-file", "简介文件", "file")]) }));
  await page.route("**/api/v1/resources/info-file", route => route.fulfill({ json: resource("info-file", "简介文件", "file", { parentId: "real-parent" }) }));
  const files = await openFiles(page);
  await files.getByRole("button", { name: "更多操作 简介文件", exact: true }).click();
  await page.getByRole("menuitem", { name: "显示简介", exact: true }).click();
  const info = page.getByRole("dialog", { name: "显示简介", exact: true });
  await expect(info).toContainText("共享根目录 / 真实父目录 / 简介文件");
});

test("live gateway create rename and remote removal honor the file contract", async ({ page }) => {
  const files = await openFiles(page);
  const token = await page.evaluate(() => localStorage.getItem("linkos.access_token"));
  const headers = { authorization: `Bearer ${token}` };
  const rootName = `000-f3-${crypto.randomUUID()}`;
  const response = await page.request.post("/api/v1/resources", { headers, data: { type: "folder", name: rootName, parentId: "" } });
  expect(response.status()).toBe(201);
  const root = await response.json();
  try {
    const contract = await (await page.request.get(`/api/v1/resources?scope=files&parentId=${root.id}`, { headers })).json();
    expect(contract, "live gateway must expose the F3 directory contract").toMatchObject({ ancestors: [{ id: root.id, name: rootName }], canRead: true, canWrite: true, canCreateChild: true, total: 0 });
    await files.getByRole("textbox", { name: "搜索文件" }).fill(rootName);
    await openFolder(page, rootName);
    await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText(rootName);
    await files.getByRole("button", { name: "新建文件夹", exact: true }).click();
    const form = page.getByRole("dialog", { name: "新建文件夹", exact: true });
    await form.getByRole("textbox", { name: "名称", exact: true }).fill("子目录");
    await form.getByRole("button", { name: "创建", exact: true }).click();
    const child = files.getByRole("row", { name: "子目录", exact: true });
    await expect(child).toBeVisible();
    await child.focus();
    await child.press("F2");
    const rename = page.getByRole("dialog", { name: "重命名", exact: true });
    await rename.getByRole("textbox", { name: "名称", exact: true }).fill("已重命名");
    await rename.getByRole("button", { name: "重命名", exact: true }).click();
    await expect(files.getByRole("row", { name: "已重命名", exact: true })).toBeVisible();
    const childId = await files.getByRole("row", { name: "已重命名", exact: true }).getAttribute("data-resource-id");
    await openFolder(page, "已重命名");
    await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("已重命名");
    const removed = await page.request.delete(`/api/v1/resources/${childId}?recursive=true`, { headers });
    expect(removed.ok()).toBe(true);
    await expect(files.locator('p[role="status"]').filter({ hasText: "已返回" })).toBeVisible();
    await expect(files.getByRole("navigation", { name: "文件路径" })).not.toContainText("已重命名");
    await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText(rootName);
  } finally {
    await page.request.delete(`/api/v1/resources/${root.id}?recursive=true`, { headers });
  }
});

test("mobile objects have reachable menus, single tap folders, and no 390px overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("parentId") === "mobile" ? listing([], { ancestors: [{ id: "mobile", name: "手机目录" }] }) : listing([resource("mobile", "手机目录")]) }));
  const files = await openFiles(page);
  await expect(files.getByRole("button", { name: "更多操作 手机目录", exact: true })).toBeVisible();
  await openFolder(page, "手机目录");
  await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("手机目录");
  expect(await files.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await files.getByRole("button", { name: "文件位置", exact: true }).click();
  await expect(files.getByRole("button", { name: "本机历史", exact: true })).toBeVisible();
});

test("background menu changes view and server sorting with selected feedback", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: listing([resource("sorted", `${params.get("sortBy")}-${params.get("sortOrder")}`, "file")]) });
  });
  const files = await openFiles(page);
  const content = files.getByLabel("文件内容", { exact: true });
  const background = { position: { x: 4, y: 200 }, button: "right" as const };
  await content.click(background);
  await expect(page.getByRole("menuitem", { name: /列表视图.*已选中/ })).toBeVisible();
  await page.getByRole("menuitem", { name: "图标视图", exact: true }).click();
  await expect(files.getByRole("gridcell", { name: "name-asc", exact: true })).toBeVisible();
  await content.click(background);
  await expect(page.getByRole("menuitem", { name: /图标视图.*已选中/ })).toBeVisible();
  await page.getByRole("menuitem", { name: "列表视图", exact: true }).click();
  for (const [label, field] of [["修改时间", "updatedAt"], ["大小", "size"], ["名称", "name"]]) {
    await content.click(background);
    await page.getByRole("menuitem", { name: `按${label}排序`, exact: true }).click();
    await expect(files.getByRole("row", { name: `${field}-asc`, exact: true })).toBeVisible();
    await files.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: `按${label}排序（升序）`, exact: true }).click();
    await expect(files.getByRole("row", { name: `${field}-desc`, exact: true })).toBeVisible();
    await content.click(background);
    await expect(page.getByRole("menuitem", { name: `按${label}排序（降序）`, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

test("only blank content clicks clear file selection", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("select", "可选择文件", "file")]) }));
  const files = await openFiles(page);
  const item = files.getByRole("row", { name: "可选择文件", exact: true });
  await item.getByText("可选择文件", { exact: true }).click();
  await expect(item).toHaveAttribute("aria-selected", "true");
  await files.getByRole("button", { name: "更多操作 可选择文件", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(item).toHaveAttribute("aria-selected", "true");
  await files.getByRole("button", { name: "列表视图", exact: true }).click();
  await expect(item).toHaveAttribute("aria-selected", "true");
  await files.getByLabel("文件内容", { exact: true }).click({ position: { x: 4, y: 200 } });
  await expect(item).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Delete");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("icon names wrap to two lines with an accessible full name", async ({ page }) => {
  const name = "季度财务分析及文件归档清单最终审核版本.pdf";
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("long", name, "file")]) }));
  const files = await openFiles(page);
  await files.getByRole("button", { name: "图标视图" }).click();
  const item = files.getByRole("gridcell", { name, exact: true });
  await expect(item).toBeVisible();
  const label = item.getByText(name, { exact: true });
  await expect(label).toHaveAttribute("title", name);
  await expect(label).toHaveCSS("-webkit-line-clamp", "2");
  await expect(label).not.toHaveCSS("white-space", "nowrap");
});

test("list has separate type and size columns", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("folder", "类型目录"), resource("file", "类型文件", "file", { meta: { size: 2048 } })]) }));
  const files = await openFiles(page);
  await expect(files.getByRole("columnheader", { name: "类型", exact: true })).toBeVisible();
  const folder = files.getByRole("row", { name: "类型目录", exact: true });
  await expect(folder.getByRole("gridcell", { name: "文件夹", exact: true })).toBeVisible();
  await expect(folder.getByRole("gridcell", { name: "—", exact: true })).toBeVisible();
  const file = files.getByRole("row", { name: "类型文件", exact: true });
  await expect(file.getByRole("gridcell", { name: "文件", exact: true })).toBeVisible();
  await expect(file.getByRole("gridcell", { name: "2.0 KB", exact: true })).toBeVisible();
});

for (const empty of [false, true]) test(`initial skeleton becomes nonblocking refresh feedback (empty ${empty})`, async ({ page }) => {
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/resources?*", async route => {
    await gate;
    await route.fulfill({ json: listing(empty ? [] : [resource("refresh", "保留内容", "file")]) });
  });
  const files = await openFiles(page);
  const skeleton = files.getByRole("status", { name: "文件列表加载中", exact: true });
  await expect(skeleton).toBeVisible();
  await expect(skeleton.locator(".animate-pulse")).not.toHaveCount(0);
  release();
  const content = empty ? files.getByText("此文件夹为空", { exact: true }) : files.getByRole("row", { name: "保留内容", exact: true });
  await expect(content).toBeVisible();
  if (!empty) await content.click();
  gate = new Promise<void>(resolve => { release = resolve; });
  await files.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(files.getByRole("status", { name: "正在刷新文件", exact: true })).toBeVisible();
  await expect(skeleton).toHaveCount(0);
  await expect(content).toBeVisible();
  await expect(files.getByRole("textbox", { name: "搜索文件" })).toBeEnabled();
  if (!empty) await expect(content).toHaveAttribute("aria-selected", "true");
  release();
  await expect(files.getByRole("status", { name: "正在刷新文件", exact: true })).toHaveCount(0);
});

test("directory title and bottom path follow server ancestry", async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => {
    const parent = new URL(route.request().url()).searchParams.get("parentId");
    return route.fulfill({ json: parent === "nested" ? listing([], { ancestors: [{ id: "real", name: "真正上级" }, { id: "nested", name: "标题目录" }] }) : listing([resource("nested", "标题目录")]) });
  });
  const files = await openFiles(page);
  await expect(files.getByRole("heading", { name: "共享根目录", exact: true })).toBeVisible();
  await openFolder(page, "标题目录");
  await expect(files.getByRole("heading", { name: "标题目录", exact: true })).toBeVisible();
  const path = files.getByRole("navigation", { name: "文件路径", exact: true });
  await expect(path).toContainText("真正上级");
  const contentBox = await files.getByLabel("文件内容", { exact: true }).boundingBox();
  const pathBox = await path.boundingBox();
  expect(pathBox!.y).toBeGreaterThanOrEqual(contentBox!.y + contentBox!.height - 1);
  const request = page.waitForRequest(req => new URL(req.url()).searchParams.get("parentId") === "real");
  await path.getByRole("button", { name: "真正上级", exact: true }).click();
  await request;
});

test("390px locations drawer exposes real reachable navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([]) }));
  const files = await openFiles(page);
  const toggle = files.getByRole("button", { name: "文件位置", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(files.getByRole("button", { name: "最近文件", exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(files.getByRole("navigation", { name: "文件位置", exact: true })).toBeVisible();
  await files.getByRole("button", { name: "最近文件", exact: true }).click();
  await expect(files.getByText("暂无最近文件", { exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await files.getByRole("button", { name: "本机历史", exact: true }).click();
  await expect(files.getByText("暂无本机历史", { exact: true })).toBeVisible();
  await toggle.click();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  expect(await files.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("delete starts on cancel and Enter safely cancels", async ({ page }) => {
  await mockPersonalLocations(page);
  let deletes = 0;
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("safe", "安全删除", "file")]) }));
  await page.route("**/api/v1/resources/safe?*", route => { deletes++; return route.fulfill({ json: {} }); });
  const files = await openFiles(page);
  await chooseLocation(page, "废纸篓");
  const item = files.getByRole("row", { name: "安全删除", exact: true });
  await item.focus();
  await item.press("Delete");
  const dialog = page.getByRole("alertdialog", { name: "确认删除" });
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(item).toBeFocused();
  expect(deletes).toBe(0);
});

for (const rename of [false, true]) test(`invalid names validate while typing before submit (rename ${rename})`, async ({ page }) => {
  await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("name", "有效名称", "file")]) }));
  const files = await openFiles(page);
  if (rename) {
    await files.getByRole("row", { name: "有效名称", exact: true }).press("F2");
  } else {
    await files.getByRole("button", { name: "新建文件夹", exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name: rename ? "重命名" : "新建文件夹", exact: true });
  const name = dialog.getByRole("textbox", { name: "名称", exact: true });
  const submit = dialog.getByRole("button", { name: rename ? "重命名" : "创建", exact: true });
  for (const invalid of ["bad/name", "..", " ", "长".repeat(86)]) {
    await name.fill(invalid);
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(submit).toBeDisabled();
  }
  await name.fill("有效新名称");
  await expect(name).toHaveAttribute("aria-invalid", "false");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(submit).toBeEnabled();
});

test("offline connection change preserves cached listing without failed refresh", async ({ page }) => {
  let socket!: WebSocketRoute;
  let offline = false;
  let offlineRequests = 0;
  await page.routeWebSocket("**/api/v1/ws?*", ws => { socket = ws; });
  await page.route("**/api/v1/resources?*", route => {
    if (offline) { offlineRequests++; return route.abort("internetdisconnected"); }
    return route.fulfill({ json: listing([resource("cached", "缓存文件", "file")]) });
  });
  const files = await openFiles(page);
  await expect(files.getByRole("row", { name: "缓存文件", exact: true })).toBeVisible();
  offline = true;
  await socket.close();
  await expect(files.getByRole("alert")).toHaveText(/网关离线/);
  await files.getByRole("button", { name: "图标视图", exact: true }).click();
  await files.getByRole("gridcell", { name: "缓存文件", exact: true }).click();
  await expect(files.getByRole("gridcell", { name: "缓存文件", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(files.getByRole("button", { name: "上传文件", exact: true })).toBeDisabled();
  await expect(files.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
  expect(offlineRequests).toBe(0);
});
