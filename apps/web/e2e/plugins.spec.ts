import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPrivateKey } from "node:crypto";
import { packPlugin, packageFiles } from "../../../scripts/plugin-package.mjs";

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
  await page.evaluate(()=>{Object.assign(window,{frameViolations:[]});document.addEventListener("securitypolicyviolation",event=>{if(event.blockedURI.includes("example.invalid"))(window as unknown as {frameViolations:string[]}).frameViolations.push(event.effectiveDirective);});});
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) externalRequests++;
  });
  await frame.getByRole("button", { name: "Test network" }).click();
  await expect(frame.getByText("NETWORK BLOCKED")).toBeVisible();
  await frame.getByRole("button", { name: "Test navigation" }).click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {frameViolations:string[]}).frameViolations)).toContain("frame-src");
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
