import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPrivateKey } from "node:crypto";
import { packPlugin, packageFiles } from "../../../scripts/plugin-package.mjs";
import ts from "typescript";

test.describe.configure({ mode: "serial" });
async function signingKey() {
  return process.env.LINKOS_E2E_PLUGIN_SIGNING_KEY
    ? createPrivateKey(
        await readFile(process.env.LINKOS_E2E_PLUGIN_SIGNING_KEY),
      )
    : undefined;
}
async function login(page: Page, role = "admin") {
  await page.goto("/");
  await page.getByLabel("显示名").fill(`Plugin ${role}`);
  if (role === "admin")
    await page
      .getByLabel(/口令/)
      .fill(process.env.LINKOS_E2E_ADMIN_PASSCODE ?? "linkos-admin");
  await page.getByRole("button", { name: "登录进入" }).click();
  await expect(
    page
      .locator(".desktop-icons")
      .getByRole("button", { name: "应用管理", exact: true }),
  ).toBeVisible();
}
async function auth(page: Page) {
  return {
    authorization: `Bearer ${await page.evaluate(() => localStorage.getItem("linkos.access_token"))}`,
  };
}
async function open(page: Page, name: string) {
  const icon = page
    .locator(".desktop-icons")
    .getByRole("button", { name, exact: true });
  if ((page.viewportSize()?.width ?? 1024) < 768) await icon.click();
  else await icon.dblclick();
  await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible();
}
async function change(page: Page, id: string, action: string) {
  const headers = await auth(page),
    list = await (
      await page.request.get("/api/v1/plugins", { headers })
    ).json();
  const rec = list.items.find((item: any) => item.id === id);
  const response = await page.request.post(`/api/v1/plugins/${id}/${action}`, {
    headers,
    data: { expectedRevision: rec.revision },
  });
  expect(response.status()).toBe(200);
}
test("plugin context menus use the host base and old packages stay strictly silent", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop context-menu and focus contract");
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await login(page);
  const headers = await auth(page);
  const sdkSource = await readFile(
    "../../packages/plugin-sdk/src/index.ts",
    "utf8",
  );
  const sdk = ts.transpileModule(sdkSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
  expect(sdk).not.toMatch(/^import\s/m);
  async function installMenu(name: string, legacy: boolean) {
    const id = `fixture.menu-${crypto.randomUUID().slice(0, 8)}`;
    const manifest = {
      id,
      name,
      version: "1.0.0",
      apiVersion: "1.0",
      entry: { ui: "ui/index.html" },
      permissions: legacy ? [] : ["ui.command"],
      contributes: { commands: legacy ? [] : ["refresh"] },
      network: { mode: "deny" },
    };
    const code = legacy
      ? `addEventListener('message',e=>{const d=e.data;if(d.type==='linkos.host.init')parent.postMessage({type:'linkos.plugin.ready',nonce:d.nonce,pluginId:d.pluginId,version:d.version,protocol:'1.0'},'*')});document.body.dataset.ready='true';`
      : `import {connectPlugin} from './linkos-sdk.js';globalThis.menuResponses=[];addEventListener('message',event=>{if(event.data.type==='linkos.host.connect')event.ports[0].addEventListener('message',message=>globalThis.menuResponses.push(message.data))});const sdk=await connectPlugin(${JSON.stringify(manifest)});let count=0;sdk.ui.registerCommand({id:'refresh',title:${JSON.stringify(`刷新 ${name}`)},run(){document.querySelector('#count').textContent=String(++count)}});const remove=sdk.ui.registerContextMenu(document.querySelector('#scope'),()=>[{id:'main',items:[{commandId:'refresh',disabled:globalThis.menuDisabled===true}]}]);document.querySelector('#remove').onclick=remove;document.body.dataset.ready='true';`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="scope" tabindex="0">菜单区域</div><input aria-label="插件输入"><button id="remove">注销菜单</button><p id="count">0</p><p id="blank">无菜单区域</p><script type="module">${code}</script></body></html>`;
    const files = new Map([
      ["manifest.json", Buffer.from(JSON.stringify(manifest))],
      ["ui/index.html", Buffer.from(html)],
    ]);
    if (!legacy) files.set("ui/linkos-sdk.js", Buffer.from(sdk));
    const data = packageFiles(files, await signingKey());
    let inspected!: Awaited<ReturnType<typeof page.request.post>>;
    // Package inspection deliberately permits only two requests per second.
    await expect
      .poll(
        async () => {
          inspected = await page.request.post(
            "/api/v1/plugin-packages/inspect",
            {
              headers: { ...headers, "content-type": "application/zip" },
              data,
            },
          );
          return inspected.status();
        },
        { intervals: [250, 500, 1000] },
      )
      .not.toBe(429);
    expect(inspected.ok(), await inspected.text()).toBeTruthy();
    const stage = await inspected.json();
    const ticketResponse = await page.request.post(
      `/api/v1/plugins/${id}/ticket`,
      { headers, data: { stageId: stage.stageId } },
    );
    expect(ticketResponse.ok()).toBeTruthy();
    const ticket = await ticketResponse.json();
    expect((await page.request.get(ticket.src)).ok()).toBeTruthy();
    const installed = await page.request.post(`/api/v1/plugins/${id}/install`, {
      headers,
      data: {
        stageId: stage.stageId,
        expectedRevision: stage.expectedRevision,
        probeNonce: ticket.nonce,
      },
    });
    expect(installed.ok(), await installed.text()).toBeTruthy();
    await change(page, id, "enable");
    const frame = page.frameLocator(`iframe[title="${name} 插件沙箱"]`);
    return { id, frame, name };
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  const first = await installMenu(`菜单测试 A ${suffix}`, false);
  const second = await installMenu(`菜单测试 B ${suffix}`, false);
  const old = await installMenu(`旧插件静默 ${suffix}`, true);
  // Restored pinned plugins must still have one physical menu scope per icon.
  await page.reload();
  for (const item of [first, second, old])
    await expect(page.locator(`[data-dock-app="plugin:${item.id}"]`)).toHaveCount(1);
  await open(page, first.name);
  await expect(first.frame.locator('body[data-ready="true"]')).toBeVisible();
  expect(
    await first.frame.locator("body").evaluate(() => document.compatMode),
  ).toBe("CSS1Compat");
  await first.frame.locator("#scope").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: `刷新 ${first.name}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath("plugin-context-menu.png"),
  });
  await expect(
    page.getByRole("menuitem", { name: "系统设置", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: `刷新 ${first.name}`, exact: true })
    .click();
  await expect(first.frame.locator("#count")).toHaveText("1");
  await expect(first.frame.locator("#scope")).toBeFocused();
  await first.frame.locator("#scope").press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: `刷新 ${first.name}`, exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(first.frame.locator("#scope")).toBeFocused();
  await first.frame.locator("body").evaluate(() => {
    (globalThis as any).menuDisabled = true;
  });
  await first.frame.locator("#scope").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: `刷新 ${first.name}`, exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeFocused();
  await expect(first.frame.locator("#count")).toHaveText("1");
  await page.keyboard.press("Escape");
  await first.frame.locator("body").evaluate(() => {
    (globalThis as any).menuDisabled = false;
  });
  // A's window can cover B's desktop icon; launch through the reachable Dock.
  await page.locator(`[data-dock-app="plugin:${second.id}"]`).click();
  await expect(second.frame.locator('body[data-ready="true"]')).toBeVisible();
  await second.frame.locator("#scope").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: `刷新 ${second.name}`, exact: true })
    .click();
  await expect(second.frame.locator("#count")).toHaveText("1");
  await expect(first.frame.locator("#count")).toHaveText("1");

  // Hold an already authorized HTTP response, then invalidate the gesture.
  // Waiting for the corresponding null RPC response proves the late path ran.
  for (const action of ["escape", "input", "shell-menu", "minimize"] as const) {
    let release!: () => void;
    let arrived!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const url = `**/api/v1/plugins/${second.id}/rpc`;
    await page.route(url, async (route) => {
      if (route.request().postDataJSON()?.method !== "auth.check")
        return route.continue();
      const response = await route.fetch();
      arrived();
      await hold;
      await route.fulfill({ response });
    });
    const cancelled = () =>
      second.frame
        .locator("body")
        .evaluate(
          () =>
            (globalThis as any).menuResponses.filter(
              (message: any) =>
                message.type === "response" && message.result?.token === null,
            ).length as number,
        );
    const before = await cancelled();
    try {
      await second.frame.locator("#scope").click({ button: "right" });
      await reached;
      if (action === "escape")
        await second.frame.locator("#scope").press("Escape");
      if (action === "input") await second.frame.getByLabel("插件输入").click();
      if (action === "shell-menu")
        await page
          .getByLabel(`${second.name} 标题栏`, { exact: true })
          .click({ button: "right" });
      if (action === "minimize")
        await page
          .getByRole("button", { name: `最小化 ${second.name}`, exact: true })
          .click();
      release();
      await expect.poll(cancelled).toBe(before + 1);
      await expect(
        page.getByRole("menuitem", {
          name: `刷新 ${second.name}`,
          exact: true,
        }),
      ).toHaveCount(0);
      if (action === "shell-menu") {
        await expect(
          page.getByRole("menuitem", { name: "最小化", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
      } else await expect(page.getByRole("menu")).toHaveCount(0);
    } finally {
      release();
      await page.unroute(url);
    }
    if (action === "minimize")
      await page.locator(`[data-dock-app="plugin:${second.id}"]`).click();
  }
  await second.frame.getByRole("button", { name: "注销菜单" }).click();
  await second.frame.locator("#scope").click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page
    .getByRole("button", { name: `最小化 ${second.name}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: `最小化 ${first.name}`, exact: true })
    .click();
  await open(page, old.name);
  await expect(old.frame.locator('body[data-ready="true"]')).toBeVisible();
  expect(
    await old.frame.locator("body").evaluate(() => document.compatMode),
  ).toBe("CSS1Compat");
  for (const selector of ["#scope", "#blank", "input"]) {
    const target = old.frame.locator(selector);
    await target.click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(
      await target.evaluate((element) => {
        const event = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
  }
  await old.frame.getByLabel("插件输入").fill("仍可正常输入");
  await old.frame.getByLabel("插件输入").press("Shift+F10");
  await expect(page.getByRole("menu")).toHaveCount(0);
  for (const item of [first, second, old]) {
    await change(page, item.id, "disable");
    await change(page, item.id, "uninstall");
  }
  expect(errors).toEqual([]);
});

test("official disable removes real windows and launchers; session drafts survive denied storage", async ({
  page,
  browser,
}) => {
  await login(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "聊天");
  await page.getByLabel("消息输入").fill("应用停用前草稿");
  await page.evaluate(() => {
    const old = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("linkos.chat.draft"))
        throw new DOMException("blocked");
      return old.call(this, key, value);
    };
  });
  await page.getByLabel("消息输入").fill("仅会话内草稿");
  const second = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const other = await second.newPage();
  try {
    await login(other);
    await open(other, "聊天");
    await change(page, "chat.core", "disable");
    await expect(
      page.getByRole("dialog", { name: "聊天", exact: true }),
    ).toHaveCount(0);
    await expect(
      other.getByRole("dialog", { name: "聊天", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "聊天", exact: true }),
    ).toHaveCount(0);
    await change(page, "chat.core", "enable");
    await open(page, "聊天");
    await expect(page.getByLabel("消息输入")).toHaveValue("仅会话内草稿");
    expect(errors).toEqual([]);
  } finally {
    await change(page, "chat.core", "enable");
    await second.close();
  }
});
test("complete package installs through a sandbox probe, reads via SDK and rolls back resources", async ({
  page,
}) => {
  test.setTimeout(60000);
  await login(page);
  await open(page, "应用管理");
  const file = path.resolve(
    "../../.local/plugin-implementation/e2e-viewer.linkos-plugin",
  );
  await packPlugin(
    path.resolve("../../examples/plugins/resource-viewer"),
    file,
    process.env.LINKOS_E2E_PLUGIN_SIGNING_KEY,
  );
  const manager = page.getByRole("dialog", { name: "应用管理", exact: true });
  await manager.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "确认权限，验证并安装" }).click();
  await expect(
    page.getByRole("dialog", { name: "安装 资源阅读器", exact: true }),
  ).toHaveCount(0);
  await manager.getByRole("button", { name: "选择应用 资源阅读器" }).click();
  if (await manager.getByRole("button", { name: "启用应用" }).isVisible()) {
    await manager.getByRole("button", { name: "启用应用" }).click();
    await page.getByRole("button", { name: "确认操作" }).click();
  }
  await expect(manager.getByRole("button", { name: "打开应用" })).toBeVisible();
  await manager.getByRole("button", { name: "打开应用" }).click();
  const frame = page.frameLocator('iframe[title="资源阅读器 插件沙箱"]');
  await expect(frame.getByText("资源已加载", { exact: true })).toBeVisible();
  await expect(frame.locator("#resources li").first()).toBeVisible();
  const frameURL = await page
    .locator('iframe[title="资源阅读器 插件沙箱"]')
    .getAttribute("src");
  // An unrelated plugin update must not remount this sandbox.
  await change(page, "files.core", "disable");
  await expect(
    page.getByRole("button", { name: "文件", exact: true }),
  ).toHaveCount(0);
  expect(
    await page
      .locator('iframe[title="资源阅读器 插件沙箱"]')
      .getAttribute("src"),
  ).toBe(frameURL);
  await change(page, "files.core", "enable");
  const headers = await auth(page),
    manifest = JSON.parse(
      await readFile(
        "../../examples/plugins/resource-viewer/manifest.json",
        "utf8",
      ),
    );
  manifest.version = "2.0.0";
  manifest.permissions = [];
  const html = `<html><body>VERSION TWO<button onclick="fetch('https://example.invalid/').catch(()=>document.querySelector('#result').textContent='NETWORK BLOCKED')">Test network</button><button onclick="location.href='https://example.invalid/'">Test navigation</button><p id="result"></p><script>addEventListener('message',e=>{const d=e.data;if(d.type==='linkos.host.init')parent.postMessage({type:'linkos.plugin.ready',nonce:d.nonce,pluginId:d.pluginId,version:d.version,protocol:'1.0'},'*')})</script></body></html>`;
  const buffer = packageFiles(
    new Map([
      ["manifest.json", Buffer.from(JSON.stringify(manifest))],
      ["ui/index.html", Buffer.from(html)],
    ]),
    await signingKey(),
  );
  await page
    .getByRole("button", { name: "关闭 资源阅读器", exact: true })
    .click();
  await manager.locator('input[type="file"]').setInputFiles({
    name: "upgrade.linkos-plugin",
    mimeType: "application/zip",
    buffer,
  });
  await page.getByRole("button", { name: "确认权限，验证并安装" }).click();
  await expect(
    page.getByRole("dialog", { name: "安装 资源阅读器", exact: true }),
  ).toHaveCount(0);
  await manager.getByRole("button", { name: "打开应用" }).click();
  await expect(frame.getByText("VERSION TWO")).toBeVisible();
  let externalRequests = 0;
  await page.evaluate(() => {
    Object.assign(window, { frameViolations: [] });
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.blockedURI.includes("example.invalid"))
        (
          window as unknown as { frameViolations: string[] }
        ).frameViolations.push(event.effectiveDirective);
    });
  });
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) externalRequests++;
  });
  await frame.getByRole("button", { name: "Test network" }).click();
  await expect(frame.getByText("NETWORK BLOCKED")).toBeVisible();
  await frame.getByRole("button", { name: "Test navigation" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { frameViolations: string[] }).frameViolations,
      ),
    )
    .toContain("frame-src");
  expect(externalRequests).toBe(0);
  await page
    .getByRole("button", { name: "关闭 资源阅读器", exact: true })
    .click();
  await manager.getByRole("button", { name: "回滚上一版本" }).click();
  await page.getByRole("button", { name: "确认操作" }).click();
  await expect(
    manager.getByText("example.resource-viewer · v1.0.0", { exact: true }),
  ).toBeVisible();
  await manager.getByRole("button", { name: "打开应用" }).click();
  await expect(frame.getByText("资源已加载", { exact: true })).toBeVisible();
  const list = await (
    await page.request.get("/api/v1/plugins", { headers })
  ).json();
  const record = list.items.find((item: any) => item.id === manifest.id);
  const rollback = await page.request.post(
    `/api/v1/plugins/${manifest.id}/rollback`,
    { headers, data: { expectedRevision: record.revision } },
  );
  expect(rollback.status()).toBe(409);
  await page.screenshot({
    path: path.resolve(
      "../../.local/plugin-implementation/plugins-" +
        test.info().project.name +
        ".png",
    ),
  });
});
test("files, code and tasks obey app state and code drafts survive disabling", async ({
  page,
}) => {
  await login(page);
  for (const [name, id] of [
    ["文件", "files.core"],
    ["任务", "runner.exec"],
  ]) {
    try {
      await open(page, name);
      await change(page, id, "disable");
      await expect(page.getByRole("dialog", { name, exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
        0,
      );
    } finally {
      await change(page, id, "enable");
    }
  }
  const fixture = await page.request.post("/api/v1/code/files", {
    headers: await auth(page),
    data: {
      projectId: "project_gateway",
      path: `plugin-lifecycle-${crypto.randomUUID()}.txt`,
      language: "text",
      content: "editable lifecycle fixture",
    },
  });
  expect(fixture.status()).toBe(201);
  const { file } = await fixture.json();
  await page.evaluate((id) => {
    const profile = JSON.parse(localStorage.getItem("linkos.access_profile")!);
    const scope = JSON.stringify([
      localStorage.getItem("linkos.gateway_base") ?? "",
      profile.workspaceId,
      profile.userId,
    ]);
    localStorage.setItem(`linkos.code.draft.${scope}.active`, id);
  }, file.id);
  await open(page, "代码");
  const editor = page.locator(".cm-content");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await page.evaluate(() => {
    const old = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("linkos.code.draft"))
        throw new DOMException("blocked");
      return old.call(this, key, value);
    };
  });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("// preserved code draft");
  try {
    await change(page, "code.workbench", "disable");
    await expect(
      page.getByRole("dialog", { name: "代码", exact: true }),
    ).toHaveCount(0);
    await change(page, "code.workbench", "enable");
    await open(page, "代码");
    await expect(page.locator(".cm-content")).toContainText(
      "// preserved code draft",
    );
  } finally {
    await change(page, "code.workbench", "enable");
  }
});
test("HTTP management works with WebSocket disconnected; member sees read-only controls", async ({
  page,
}) => {
  await page.routeWebSocket(/\/api\/v1\/ws/, (socket) => socket.close());
  await login(page);
  await open(page, "应用管理");
  const manager = page.getByRole("dialog", { name: "应用管理", exact: true });
  await manager.getByRole("button", { name: "选择应用 聊天" }).click();
  await expect(manager.getByText(/实时连接中断/)).toBeVisible();
  await manager.getByRole("button", { name: "停用应用" }).click();
  await page.getByRole("button", { name: "确认操作" }).click();
  await expect(manager.getByRole("button", { name: "启用应用" })).toBeVisible();
  await manager.getByRole("button", { name: "刷新应用列表" }).click();
  await manager.getByRole("button", { name: "启用应用" }).click();
  await page.getByRole("button", { name: "确认操作" }).click();
  await expect(manager.getByRole("button", { name: "停用应用" })).toBeVisible();
});
test("failed candidate handshake and forged source messages preserve the committed version", async ({
  page,
}) => {
  await login(page);
  await open(page, "应用管理");
  const manager = page.getByRole("dialog", { name: "应用管理", exact: true });
  const manifest = JSON.parse(
    await readFile(
      "../../examples/plugins/resource-viewer/manifest.json",
      "utf8",
    ),
  );
  manifest.version = "3.0.0";
  const buffer = packageFiles(
    new Map([
      ["manifest.json", Buffer.from(JSON.stringify(manifest))],
      [
        "ui/index.html",
        Buffer.from("<html><body>Broken candidate</body></html>"),
      ],
    ]),
    await signingKey(),
  );
  await manager.locator('input[type="file"]').setInputFiles({
    name: "broken.linkos-plugin",
    mimeType: "application/zip",
    buffer,
  });
  await page.getByRole("button", { name: "确认权限，验证并安装" }).click();
  await expect(
    page.locator('iframe[title="资源阅读器 插件沙箱"]'),
  ).toBeVisible();
  await page.evaluate(() => {
    const src = document.querySelector("iframe")!.getAttribute("src")!;
    const nonce = src.split("plugin-views/")[1].split("/")[0];
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "null",
        data: {
          type: "linkos.plugin.ready",
          nonce,
          pluginId: "example.resource-viewer",
          version: "3.0.0",
          protocol: "1.0",
        },
      }),
    );
  });
  await expect(
    page.getByText("插件握手超时，界面未能启动", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  const list = await (
    await page.request.get("/api/v1/plugins", { headers: await auth(page) })
  ).json();
  expect(list.items.find((item: any) => item.id === manifest.id).version).toBe(
    "1.0.0",
  );
});
test("member cannot mutate plugins using the page or direct HTTP", async ({
  page,
}) => {
  await login(page, "member");
  await open(page, "应用管理");
  const manager = page.getByRole("dialog", { name: "应用管理", exact: true });
  await expect(manager.getByText("只读查看", { exact: false })).toBeVisible();
  await expect(manager.getByRole("button", { name: "安装应用" })).toHaveCount(
    0,
  );
  await expect(manager.getByRole("button", { name: "停用应用" })).toHaveCount(
    0,
  );
  const response = await page.request.post(
    "/api/v1/plugins/chat.core/disable",
    { headers: await auth(page), data: { expectedRevision: 1 } },
  );
  expect(response.status()).toBe(403);
});
