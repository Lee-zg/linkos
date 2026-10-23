import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function login(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("显示名").fill(name);
  await page.getByLabel(/口令/).fill(process.env.LINKOS_E2E_ADMIN_PASSCODE ?? "linkos-admin");
  const button = page.getByRole("button", { name: "登录进入" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator(".dock-connection")).toHaveAttribute("aria-label", "已连接工作区");
}

async function openFiles(page: Page) {
  await page.getByRole("button", { name: "文件", exact: true }).last().click();
  await expect(page.getByRole("dialog", { name: "文件", exact: true })).toBeVisible();
}

async function headers(page: Page) {
  return { authorization: `Bearer ${await page.evaluate(() => localStorage.getItem("linkos.access_token"))}` };
}

test("directory notifications refresh another browser without reopening", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, "Files A");
  const contextB = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const b = await contextB.newPage();
  try {
    b.on("pageerror", (error) => errors.push(error.message));
    await login(b, "Files B");
    await openFiles(b);
    const name = `协作-${crypto.randomUUID()}`;
    const auth = await headers(page);
    const created = await page.request.post("/api/v1/resources", { headers: auth, data: { type: "folder", name, parentId: "" } });
    expect(created.status()).toBe(201);
    const folder = await created.json();
    await expect(b.getByText(name, { exact: true })).toBeVisible();
    expect((await page.request.patch(`/api/v1/resources/${folder.id}`, { headers: auth, data: { name: `${name}-改名` } })).ok()).toBeTruthy();
    await expect(b.getByText(`${name}-改名`, { exact: true })).toBeVisible();
    expect((await page.request.delete(`/api/v1/resources/${folder.id}`, { headers: auth })).ok()).toBeTruthy();
    await expect(b.getByText(`${name}-改名`, { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await contextB.close();
  }
});

test("desktop object menus preserve focus and window state", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop pointer and keyboard contract");
  await login(page, "Menu acceptance");
  const icon = page.locator(".desktop-icons").getByRole("button", { name: "文件", exact: true });
  await icon.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "打开", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "文件", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(icon).toBeFocused();
  await icon.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(icon).toBeFocused();
  await icon.press("Shift+F10");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "文件", exact: true })).toBeVisible();
  const files = page.getByRole("dialog", { name: "文件", exact: true });
  await files.getByRole("button", { name: "图标视图" }).click();
  const wallpaper = page.locator(".wallpaper");
  const blank = await wallpaper.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    // Installed apps change icon positions; hit-test the actual background.
    for (let y = rect.top + 8; y < Math.min(rect.bottom, innerHeight); y += 16) {
      for (let x = rect.left + 8; x < Math.min(rect.right, innerWidth); x += 16) {
        if (document.elementFromPoint(x, y) === element)
          return { x: x - rect.left, y: y - rect.top };
      }
    }
    throw new Error("No exposed desktop background to right-click");
  });
  await wallpaper.click({ button: "right", position: blank });
  await expect(page.getByRole("menuitem", { name: "打开文件管理器" })).toBeVisible();
  await page.getByRole("menuitem", { name: "显示桌面" }).click();
  await expect(page.locator('[role="dialog"][aria-label="文件"]')).toHaveAttribute("aria-hidden", "true");
  await openFiles(page);
  await expect(files.getByRole("button", { name: "图标视图" })).toHaveAttribute("aria-pressed", "true");
  await expect(files).toHaveCount(1);
});

test("live gateway multi-selection survives right click and keyboard More copies every selected item", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop multi-selection and keyboard menu contract");
  await login(page, "Files menu selection");
  const auth = await headers(page);
  const name = `000-menu-${crypto.randomUUID()}`;
  const created = await page.request.post("/api/v1/resources", { headers: auth, data: { type: "folder", name, parentId: "" } });
  expect(created.status()).toBe(201);
  const root = await created.json();
  try {
    const children: { id: string; name: string }[] = [];
    for (const childName of ["选择甲", "选择乙", "复制目标"]) {
      const response = await page.request.post("/api/v1/resources", { headers: auth, data: { type: "folder", name: childName, parentId: root.id } });
      expect(response.status()).toBe(201);
      children.push(await response.json());
    }
    await openFiles(page);
    const files = page.getByRole("dialog", { name: "文件", exact: true });
    await files.getByRole("textbox", { name: "搜索文件" }).fill(name);
    await files.locator(`[data-resource-id="${root.id}"]`).dblclick();
    const [first, second, destination] = children;
    const firstRow = files.locator(`[data-resource-id="${first.id}"]`);
    const secondRow = files.locator(`[data-resource-id="${second.id}"]`);
    await firstRow.click();
    await secondRow.click({ modifiers: ["Control"] });
    for (const row of [firstRow, secondRow]) await expect(row).toHaveAttribute("aria-selected", "true");
    await firstRow.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    for (const row of [firstRow, secondRow]) await expect(row).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "复制", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(firstRow).toBeFocused();
    await files.locator(`[data-resource-id="${destination.id}"]`).dblclick();
    await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText(destination.name);
    const more = files.getByRole("button", { name: "更多操作", exact: true });
    await more.focus();
    await more.press("Enter");
    await expect(page.getByRole("menuitem", { name: "粘贴项目", exact: true })).toBeEnabled();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "粘贴项目", exact: true })).toBeFocused();
    const copied = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/file-operations" && response.request().method() === "POST");
    await page.keyboard.press("Enter");
    const response = await copied;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({ action: "copy", ids: [first.id, second.id], parentId: destination.id });
    for (const child of [first, second]) await expect(files.getByRole("row", { name: child.name, exact: true })).toBeVisible();
    const listing = await page.request.get(`/api/v1/resources?scope=files&parentId=${destination.id}`, { headers: auth });
    expect(listing.ok()).toBe(true);
    const entries: { id: string; name: string }[] = (await listing.json()).items;
    expect(entries.map(entry => entry.name).sort()).toEqual([first.name, second.name].sort());
    expect(entries.every(entry => entry.id !== first.id && entry.id !== second.id)).toBe(true);
    const objectMore = files.getByRole("button", { name: `更多操作 ${first.name}`, exact: true });
    await objectMore.focus();
    await objectMore.press("Space");
    await expect(page.getByRole("menuitem", { name: "打开", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(objectMore).toBeFocused();
    await objectMore.press("Shift+F10");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(objectMore).toBeFocused();
  } finally {
    expect((await page.request.delete(`/api/v1/resources/${root.id}?recursive=true`, { headers: auth })).ok()).toBe(true);
  }
});

test("global menus isolate window content, title buttons and native editor menus", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop context gestures");
  await login(page, "Menu boundaries");
  await page.getByRole("button", { name: "设置", exact: true }).last().click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(settings).toBeVisible();
  // No application provider: neither a shell menu nor the browser menu is allowed.
  const content = settings.locator("[data-context-menu-owner=app]");
  expect(await content.evaluate(el => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(false);
  await expect(page.getByRole("menu")).toHaveCount(0);
  const title = settings.getByLabel("设置 标题栏", { exact: true });
  await title.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "最小化", exact: true })).toBeVisible();
  const menu = page.getByRole("menu");
  await menu.click({ button: "right" });
  await expect(menu).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "系统设置", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const close = settings.getByRole("button", { name: "关闭 设置", exact: true });
  await close.press("Shift+F10");
  await expect(menu).toHaveCount(0);
  await close.dispatchEvent("contextmenu");
  await expect(menu).toHaveCount(0);
  // Physical descendants in an app without a provider stay silent, including readonly CodeMirror.
  for (const html of ['<input aria-label="native probe">', '<div contenteditable="true" tabindex="0">editable</div>', '<div class="cm-editor" tabindex="0"><span>readonly</span></div>']) {
    const prevented = await content.evaluate((el, markup) => {
      const host = document.createElement("div");
      host.innerHTML = markup;
      el.append(host);
      const target = host.firstElementChild as HTMLElement;
      target.focus();
      const pointer = !target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      const keyboard = !target.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
      host.remove();
      return { pointer, keyboard };
    }, html);
    expect(prevented).toEqual({ pointer: true, keyboard: true });
    await expect(menu).toHaveCount(0);
  }
  await openFiles(page);
  const files = page.getByRole("dialog", { name: "文件", exact: true });
  await files.getByLabel("文件内容", { exact: true }).press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "新建文件夹", exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(menu).toHaveCount(0);
});

test("socket bursts, repeated snapshots and reconnect refresh using one connection", async ({ page, context }) => {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    Object.assign(window, { acceptanceSockets: sockets });
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(url, location.href).pathname === "/api/v1/ws") sockets.push(this);
      }
    };
  });
  await login(page, "Refresh acceptance");
  await openFiles(page);
  await expect(page.getByText("加载中...", { exact: true })).toHaveCount(0);
  let reads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/resources" && url.searchParams.get("scope") === "files") reads++;
  });
  await page.evaluate(() => {
    const sockets = (window as unknown as { acceptanceSockets: WebSocket[] }).acceptanceSockets;
    const socket = sockets.find((item) => item.readyState === WebSocket.OPEN)!;
    for (let i = 0; i < 12; i++) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "resources.changed", eventId: `acceptance-${i}`, seq: 900 + i, payload: {} }) }));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "job.log.chunk", eventId: "acceptance-unrelated", seq: 912, payload: {} }) }));
  });
  await expect.poll(() => reads).toBeGreaterThan(0);
  expect(reads).toBeLessThanOrEqual(2);
  const burstReads = reads;
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => {
      const sockets = (window as unknown as { acceptanceSockets: WebSocket[] }).acceptanceSockets;
      sockets.find((item) => item.readyState === WebSocket.OPEN)!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "workspace.snapshot.required", payload: { currentEventSeq: 0 } }) }));
    });
    await expect.poll(() => reads).toBeGreaterThan(burstReads + i);
  }
  await context.setOffline(true);
  await page.evaluate(() => {
    for (const socket of (window as unknown as { acceptanceSockets: WebSocket[] }).acceptanceSockets) socket.close();
  });
  await expect(page.getByRole("button", { name: "上传文件", exact: true })).toBeDisabled();
  const beforeReconnect = reads;
  await context.setOffline(false);
  await expect(page.locator(".dock-connection")).toHaveAttribute("aria-label", "已连接工作区");
  await expect.poll(() => reads).toBeGreaterThan(beforeReconnect);
  expect(await page.evaluate(() => (window as unknown as { acceptanceSockets: WebSocket[] }).acceptanceSockets.filter((item) => item.readyState === WebSocket.OPEN).length)).toBe(1);
});

test("real nested upload syncs to a member and a read-only guest", async ({ page, browser, isMobile }) => {
  test.skip(isMobile, "Desktop file management flow");
  test.setTimeout(300000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, "Upload owner");
  const auth = await headers(page);
  const policyResponse = await page.request.get("/api/v1/access-policy");
  const originalPolicy = await policyResponse.json();
  expect((await page.request.patch("/api/v1/admin/access-policy", { headers: auth, data: { ...originalPolicy, allowFullAnonymous: true } })).ok()).toBeTruthy();
  const memberContext = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: page.viewportSize() });
  const guestContext = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: page.viewportSize() });
  let folderId: string | null = null;
  try {
    const member = await memberContext.newPage();
    member.on("pageerror", error => errors.push(error.message));
    await member.goto("/");
    await member.getByLabel("显示名").fill("Other member");
    await member.getByRole("button", { name: "登录进入" }).click();
    await expect(member.locator(".dock-connection")).toHaveAttribute("aria-label", "已连接工作区", { timeout: 15000 });
    const guest = await guestContext.newPage();
    guest.on("pageerror", error => errors.push(error.message));
    await guest.goto("/");
    await guest.getByRole("button", { name: "以访客身份直接进入" }).click();
    await expect(guest.locator(".dock-connection")).toHaveAttribute("aria-label", "已连接工作区", { timeout: 15000 });
    await openFiles(page);
    await openFiles(member);
    await openFiles(guest);
    const name = `共享目录-${crypto.randomUUID()}`;
    await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
    const form = page.getByRole("dialog", { name: "新建文件夹", exact: true });
    await form.getByLabel("名称").fill(name);
    await form.getByRole("button", { name: "创建", exact: true }).click();
    await expect(member.getByText(name, { exact: true })).toBeVisible();
    const row = page.locator("[data-resource-id]").filter({ hasText: name });
    folderId = await row.getAttribute("data-resource-id");
    await row.getByRole("button", { name: `更多操作 ${name}` }).click();
    await page.getByRole("menuitem", { name: "打开", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "文件路径" })).toContainText(name);
    const fileName = `内容-${crypto.randomUUID()}.txt`;
    const content = "LinkOS 真实共享文件\n";
    await page.getByLabel("选择要上传的文件").setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from(content) });
    await expect(page.getByText(fileName, { exact: true })).toBeVisible();
    const items = await (await page.request.get(`/api/v1/resources?scope=files&parentId=${folderId}`, { headers: auth })).json();
    const entry = items.items.find((item: { name: string }) => item.name === fileName);
    expect(entry.id).toMatch(/^res_/);
    const bytes = await page.request.get(`/api/v1/files/${entry.id}/content`, { headers: auth });
    expect(await bytes.text()).toBe(content);
    await page.getByRole("button", { name: `更多操作 ${fileName}` }).click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "下载", exact: true }).click();
    const downloadPath = await (await downloaded).path();
    expect(downloadPath).not.toBeNull();
    expect(await readFile(downloadPath!, "utf8")).toBe(content);
    const selected = page.locator(`[data-resource-id="${entry.id}"]`);
    await selected.click();
    await page.getByRole("button", { name: "图标视图" }).click();
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "列表视图" }).click();
    await expect(selected).toHaveAttribute("aria-selected", "true");
    for (const viewer of [member, guest]) {
      await viewer.locator("[data-resource-id]").filter({ hasText: name }).getByRole("button", { name: `更多操作 ${name}` }).click();
      await viewer.getByRole("menuitem", { name: "打开", exact: true }).click();
      await expect(viewer.getByText(fileName, { exact: true })).toBeVisible({ timeout: 10000 });
      await expect(viewer.getByRole("button", { name: "上传文件", exact: true })).toBeDisabled();
      await viewer.getByRole("button", { name: `更多操作 ${fileName}` }).click();
      await expect(viewer.getByRole("menuitem", { name: "重命名", exact: true })).toBeDisabled();
      await viewer.keyboard.press("Escape");
      const denied = await viewer.request.patch(`/api/v1/resources/${entry.id}`, { headers: await headers(viewer), data: { name: "forbidden.txt" } });
      expect(denied.status()).toBe(403);
      await viewer.getByRole("button", { name: "上一级", exact: true }).click();
    }
    expect((await guest.request.post("/api/v1/uploads", { headers: await headers(guest), data: { name: "guest.txt", size: 0 } })).status()).toBe(403);
    await member.locator("[data-resource-id]").filter({ hasText: name }).getByRole("button", { name: `更多操作 ${name}` }).click();
    await member.getByRole("menuitem", { name: "打开", exact: true }).click();
    await expect(member.getByText(fileName, { exact: true })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: `更多操作 ${fileName}` }).click();
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await page.getByRole("dialog", { name: "重命名", exact: true }).getByLabel("名称").fill(`${fileName}-renamed`);
    await page.getByRole("dialog", { name: "重命名", exact: true }).getByRole("button", { name: "重命名", exact: true }).click();
    await expect(member.getByText(`${fileName}-renamed`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: `更多操作 ${fileName}-renamed` }).click();
    await page.getByRole("menuitem", { name: "移动到...", exact: true }).click();
    const move = page.getByRole("dialog", { name: "移动到", exact: true });
    await move.getByRole("button", { name: "移动", exact: true }).click();
    await expect(move).toHaveCount(0);
    await expect(member.getByText(`${fileName}-renamed`, { exact: true })).toHaveCount(0);
    await member.getByRole("button", { name: "上一级", exact: true }).click();
    await expect(member.getByText(`${fileName}-renamed`, { exact: true })).toBeVisible();
    const ownerUp = page.getByRole("button", { name: "上一级", exact: true });
    if (await ownerUp.isEnabled()) {
      await ownerUp.click();
    }
    await page.getByRole("button", { name: `更多操作 ${fileName}-renamed` }).click();
    await page.getByRole("menuitem", { name: "移到废纸篓", exact: true }).click();
    await expect(member.getByText(`${fileName}-renamed`, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "打开废纸篓", exact: true }).click();
    await page.getByRole("button", { name: `更多操作 ${fileName}-renamed` }).click();
    await page.getByRole("menuitem", { name: "永久删除", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "确认删除" });
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByText(`${fileName}-renamed`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: `更多操作 ${fileName}-renamed` }).click();
    await page.getByRole("menuitem", { name: "永久删除", exact: true }).click();
    await confirmation.getByRole("button", { name: "删除", exact: true }).click();
    await expect(member.getByText(`${fileName}-renamed`, { exact: true })).toHaveCount(0);
    await expect(guest.getByText(`${fileName}-renamed`, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "图标视图" }).click();
    await page.screenshot({ path: test.info().outputPath("shared-files.png") });
    expect(errors).toEqual([]);
  } finally {
    try {
      if (folderId) {
        await page.request.delete(`/api/v1/resources/${folderId}`, { headers: auth });
      }
    } catch { /* best-effort cleanup */ }
    await memberContext.close();
    await guestContext.close();
    await page.request.patch("/api/v1/admin/access-policy", { headers: auth, data: originalPolicy });
  }
});
