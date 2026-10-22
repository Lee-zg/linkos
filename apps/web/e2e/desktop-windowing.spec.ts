import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createPrivateKey } from "node:crypto";
import { packageFiles } from "../../../scripts/plugin-package.mjs";

// Run every scenario even when another scenario is RED.
test.describe.configure({ mode: "default" });

async function login(page: Page) {
  const passcode = process.env.LINKOS_E2E_ADMIN_PASSCODE;
  if (!passcode) throw new Error("Isolated acceptance passcode is required");
  await page.goto("/");
  await page.getByLabel("显示名").fill("Window surface acceptance");
  await page.getByLabel(/口令/).fill(passcode);
  await page.getByRole("button", { name: "登录进入" }).click();
  await expect(page.locator(".desktop-icons")).toBeVisible();
}

async function launch(page: Page, id: string, name: string) {
  await page.locator(`[data-dock-app="${id}"]`).click();
  // Hidden surfaces must remain addressable to verify their physical DOM.
  const dialog = page.getByRole("dialog", {
    name,
    exact: true,
    includeHidden: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

function green(dialog: Locator, name: string) {
  // On the pre-phase3 implementation this is the real legacy green button.
  // RED must reach it, not fail because the new accessible name is absent.
  return dialog.getByRole("button", {
    name: new RegExp(`^(最大化|进入全屏|退出全屏) ${name}$`),
  });
}

async function activateGreen(dialog: Locator, name: string) {
  if (test.info().project.use.hasTouch) await green(dialog, name).dispatchEvent("click");
  else await green(dialog, name).dispatchEvent("click");
}

async function expectSilentScope(page: Page, target: Locator) {
  // Reset the keyboard companion latch so this proves inactive physical scope
  // routing, not merely suppression of a recent Shift+F10 companion event.
  await target.dispatchEvent("pointerdown");
  await target.dispatchEvent("contextmenu");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

async function titleAction(page: Page, name: string, action: string) {
  const title = page.getByLabel(`${name} 标题栏`, { exact: true });
  await title.focus();
  await title.press("Shift+F10");
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function expectViewport(page: Page, dialog: Locator) {
  const viewport = await page.evaluate(() => {
    const v = window.visualViewport;
    return v
      ? { x: v.offsetLeft, y: v.offsetTop, w: v.width, h: v.height }
      : { x: 0, y: 0, w: innerWidth, h: innerHeight };
  });
  await expect
    .poll(async () => {
      const r = await dialog.boundingBox();
      return r
        ? Math.max(
            Math.abs(r.x - viewport.x),
            Math.abs(r.y - viewport.y),
            Math.abs(r.width - viewport.w),
            Math.abs(r.height - viewport.h),
          )
        : Infinity;
    })
    .toBeLessThan(1);
}

async function expectShellInactive(page: Page) {
  const dock = page.locator(".desktop-dock-wrap");
  await expect(dock).toHaveAttribute("data-visible", "false");
  await expect(dock).toHaveAttribute("aria-hidden", "true");
  await expect(dock).toHaveAttribute("inert", "");
  await expect(page.locator(".desktop-icons")).toBeHidden();
  await expect(page.locator(".wallpaper")).toHaveAttribute("inert", "");
  expect(
    await page.evaluate(() => {
      const v = visualViewport;
      const element = document.elementFromPoint(
        (v?.width ?? innerWidth) / 2,
        (v?.height ?? innerHeight) - 20,
      );
      return !!element?.closest(".desktop-dock-wrap");
    }),
  ).toBe(false);
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () =>
          !!document.activeElement?.closest(
            ".desktop-dock-wrap, .desktop-icons, [aria-hidden='true']",
          ),
      ),
    ).toBe(false);
  }
}

test("green Full covers the viewport, disables yellow, and restores Normal and Fill", async ({
  page,
}) => {
  await login(page);
  const chat = await launch(page, "chat", "聊天");
  await page.getByLabel("消息输入").fill("内置跨空间草稿");
  const normal = await chat.boundingBox();
  await activateGreen(chat, "聊天");
  // Expected baseline RED: legacy green leaves an 88px hole at the bottom.
  await expectViewport(page, chat);
  await expect(chat).toHaveAttribute("data-space-type", "fullscreen");
  await expect(
    chat.getByRole("button", { name: "最小化 聊天", exact: true }),
  ).toBeDisabled();
  const title = chat.getByLabel("聊天 标题栏", { exact: true });
  await title.focus();
  await title.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "最小化", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "填充", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expectShellInactive(page);
  await expectSilentScope(page, page.locator(".desktop-icons button").first());
  await expectSilentScope(page, page.locator(".wallpaper"));
  await expectSilentScope(page, page.locator('[data-dock-app="files"]'));
  await activateGreen(chat, "聊天");
  await expect(chat).toHaveAttribute("data-placement", "normal");
  await expect.poll(() => chat.boundingBox()).toEqual(normal);
  await expect(page.getByLabel("消息输入")).toHaveValue("内置跨空间草稿");
  await titleAction(page, "聊天", "填充");
  const fill = await chat.boundingBox();
  await expect(chat).toHaveAttribute("data-space-type", "desktop");
  await expect(page.locator(".desktop-dock-wrap")).toHaveAttribute(
    "data-visible",
    "true",
  );
  const viewportHeight = await page.evaluate(
    () => visualViewport?.height ?? innerHeight,
  );
  expect(fill!.y + fill!.height).toBeLessThan(viewportHeight);
  await activateGreen(chat, "聊天");
  await expectViewport(page, chat);
  await activateGreen(chat, "聊天");
  await expect(chat).toHaveAttribute("data-placement", "fill");
  await expect.poll(() => chat.boundingBox()).toEqual(fill);
  await titleAction(page, "聊天", "还原");
  await expect.poll(() => chat.boundingBox()).toEqual(normal);
});

test("two Full Spaces remain independent and reachable through the owner title menu", async ({
  page,
}) => {
  await login(page);
  const chat = await launch(page, "chat", "聊天");
  const files = await launch(page, "files", "文件");
  await page.locator('[data-dock-app="chat"]').click();
  await activateGreen(chat, "聊天");
  await expectViewport(page, chat);
  await titleAction(page, "聊天", "显示桌面");
  await expect(chat).toBeHidden();
  await expect(chat).toHaveAttribute("inert", "");
  await expectSilentScope(page, chat.locator('[aria-label="聊天 标题栏"]'));
  const dockChat = page.locator('[data-dock-app="chat"]');
  await dockChat.focus();
  await dockChat.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "最小化", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator('[data-dock-app="files"]').click();
  await activateGreen(files, "文件");
  await expectViewport(page, files);
  const chatSpace = await chat.getAttribute("data-space-id");
  const filesSpace = await files.getAttribute("data-space-id");
  expect(chatSpace).not.toBe(filesSpace);
  await titleAction(page, "文件", "切换到 聊天");
  await expect(chat).toBeVisible();
  await expect(files).toHaveAttribute("aria-hidden", "true");
  await expect(files).toHaveAttribute("inert", "");
  await expectViewport(page, chat);
  await titleAction(page, "聊天", "切换到 文件");
  await expectViewport(page, files);
  await expect(chat).toHaveAttribute("data-space-id", chatSpace!);
  await expect(files).toHaveAttribute("data-space-id", filesSpace!);
  await activateGreen(files, "文件");
  await page.locator('[data-dock-app="chat"]').click();
  await expectViewport(page, chat);
  await expect(chat).toHaveAttribute("data-space-type", "fullscreen");
});

test("host safe insets are shared once by Fill/mobile and do not shrink the Full exterior", async ({
  page,
}) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.documentElement.style;
      style.setProperty("--desktop-safe-top", "11px");
      style.setProperty("--desktop-safe-right", "13px");
      style.setProperty("--desktop-safe-bottom", "17px");
      style.setProperty("--desktop-safe-left", "7px");
    });
  });
  await login(page);
  const chat = await launch(page, "chat", "聊天");
  await titleAction(page, "聊天", "填充");
  await expect
    .poll(async () => {
      const r = await chat.boundingBox();
      return r && { x: r.x, y: r.y };
    })
    .toEqual({ x: 7, y: 35 });
  const area = await chat.boundingBox();
  const viewport = await page.evaluate(() => ({
    w: visualViewport?.width ?? innerWidth,
    h: visualViewport?.height ?? innerHeight,
  }));
  expect(area!.width).toBeCloseTo(viewport.w - 20, 0);
  expect(area!.height).toBeCloseTo(viewport.h - 11 - 17 - 24 - 48, 0);
  await activateGreen(chat, "聊天");
  await expectViewport(page, chat);
  expect(
    await chat.evaluate((element) => ({
      top: getComputedStyle(element).paddingTop,
      bottom: getComputedStyle(element).paddingBottom,
    })),
  ).toEqual({ top: "11px", bottom: "17px" });
});

test("window ordering is bounded in its deliberate layer and owner portals escape above it", async ({
  page,
}) => {
  await login(page);
  await launch(page, "chat", "聊天");
  await launch(page, "files", "文件");
  for (let i = 0; i < 8; i++) {
    await page.locator('[data-dock-app="chat"]').click();
    await page.locator('[data-dock-app="files"]').click();
  }
  const layers = await page.evaluate(() => {
    const windows = [
      ...document.querySelectorAll<HTMLElement>(".desktop-window"),
    ];
    return {
      windowZ: windows.map((element) =>
        Number(getComputedStyle(element).zIndex),
      ),
      layerZ: getComputedStyle(document.querySelector("[data-window-layer]")!)
        .zIndex,
      isolation: getComputedStyle(
        document.querySelector("[data-window-layer]")!,
      ).isolation,
      portalZ: Number(
        getComputedStyle(document.querySelector(".window-owner-portal")!)
          .zIndex,
      ),
      dockZ: Number(
        getComputedStyle(document.querySelector(".desktop-dock-wrap")!).zIndex,
      ),
    };
  });
  expect(layers.windowZ.sort((a, b) => a - b)).toEqual([1, 2]);
  expect(layers.layerZ).toBe("100");
  expect(layers.isolation).toBe("auto");
  expect(layers.portalZ).toBeGreaterThan(Number(layers.layerZ));
  expect(layers.dockZ).toBeGreaterThan(layers.portalZ);
  expect(await page.locator(".window-owner-portal").count()).toBe(2);
});

test("closing the mobile active surface reveals the surviving canonical desktop window", async ({
  page,
  isMobile,
}) => {
  await login(page);
  const chat = await launch(page, "chat", "聊天");
  await page.getByLabel("消息输入").fill("关闭顶层后仍保留");
  const settings = await launch(page, "settings", "设置");
  if (isMobile) await expect(chat).toBeHidden();
  await settings
    .getByRole("button", { name: "关闭 设置", exact: true })
    .dispatchEvent("click");
  await expect(settings).toHaveCount(0);
  await expect(chat).toBeVisible();
  if (isMobile) await expect(chat).toHaveAttribute("data-active", "true");
  await expect(page.getByLabel("消息输入")).toHaveValue("关闭顶层后仍保留");
});

async function headers(page: Page) {
  return {
    authorization: `Bearer ${await page.evaluate(() => localStorage.getItem("linkos.access_token"))}`,
  };
}

async function change(page: Page, id: string, action: string) {
  const h = await headers(page);
  const list = await (
    await page.request.get("/api/v1/plugins", { headers: h })
  ).json();
  const record = list.items.find((item: { id: string }) => item.id === id);
  const response = await page.request.post(`/api/v1/plugins/${id}/${action}`, {
    headers: h,
    data: { expectedRevision: record.revision },
  });
  expect(response.status()).toBe(200);
}

async function installFixture(page: Page, id: string, name: string) {
  const manifest = {
    id,
    name,
    version: "1.0.0",
    apiVersion: "1.0",
    entry: { ui: "ui/index.html" },
    permissions: [],
    network: { mode: "deny" },
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <input aria-label="插件草稿"><button id="ping">MessagePort ping</button>
    <p id="boot"></p><p id="boots"></p><p id="connections">0</p><p id="replies">0</p>
    <div id="blank" tabindex="0">无权限静默区域</div>
    <script>
    globalThis.windowBootCount=(globalThis.windowBootCount||0)+1;
    document.querySelector('#boots').textContent=String(globalThis.windowBootCount);
    document.querySelector('#boot').textContent=String(Date.now())+'-'+Math.random();
    let port, connections=0, replies=0, sent=0;
    addEventListener('message',event=>{
      const d=event.data;
      if(d.type==='linkos.host.init')parent.postMessage({type:'linkos.plugin.ready',nonce:d.nonce,pluginId:d.pluginId,version:d.version,protocol:'1.0'},'*');
      if(d.type==='linkos.host.connect'){
        port=event.ports[0];document.querySelector('#connections').textContent=String(++connections);
        port.onmessage=e=>{if(e.data.type==='response'&&e.data.result?.id)document.querySelector('#replies').textContent=String(++replies)};
        port.start();document.body.dataset.ready='true';
      }
    });
    document.querySelector('#ping').onclick=()=>port.postMessage({type:'request',id:'ping-'+(++sent),method:'auth.currentUser',params:{}});
    document.addEventListener('contextmenu',e=>e.preventDefault());
    </script></body></html>`;
  const key = process.env.LINKOS_E2E_PLUGIN_SIGNING_KEY
    ? createPrivateKey(
        await readFile(process.env.LINKOS_E2E_PLUGIN_SIGNING_KEY),
      )
    : undefined;
  const data = packageFiles(
    new Map([
      ["manifest.json", Buffer.from(JSON.stringify(manifest))],
      ["ui/index.html", Buffer.from(html)],
    ]),
    key,
  );
  const h = await headers(page);
  let inspected!: Awaited<ReturnType<typeof page.request.post>>;
  await expect
    .poll(
      async () => {
        inspected = await page.request.post("/api/v1/plugin-packages/inspect", {
          headers: { ...h, "content-type": "application/zip" },
          data,
        });
        return inspected.status();
      },
      { intervals: [250, 500, 1000] },
    )
    .not.toBe(429);
  expect(inspected.ok(), await inspected.text()).toBeTruthy();
  const stage = await inspected.json();
  const response = await page.request.post(`/api/v1/plugins/${id}/ticket`, {
    headers: h,
    data: { stageId: stage.stageId },
  });
  expect(response.ok()).toBeTruthy();
  const ticket = await response.json();
  expect((await page.request.get(ticket.src)).ok()).toBeTruthy();
  const installed = await page.request.post(`/api/v1/plugins/${id}/install`, {
    headers: h,
    data: {
      stageId: stage.stageId,
      expectedRevision: stage.expectedRevision,
      probeNonce: ticket.nonce,
    },
  });
  expect(installed.ok(), await installed.text()).toBeTruthy();
  await change(page, id, "enable");
}

test("a no-permission plugin keeps the same iframe, draft, boot and port across Spaces and minimize; close destroys it", async ({
  page,
}) => {
  test.setTimeout(60000);
  await login(page);
  const id = `fixture.window-${crypto.randomUUID().slice(0, 8)}`;
  const name = `窗口插件 ${id.slice(-8)}`;
  await installFixture(page, id, name);
  try {
    await page.reload();
    await expect(page.locator(`[data-dock-app="plugin:${id}"]`)).toHaveCount(1);
    const plugin = await launch(page, `plugin:${id}`, name);
    const iframe = page.locator(`iframe[title="${name} 插件沙箱"]`);
    const frame = page.frameLocator(`iframe[title="${name} 插件沙箱"]`);
    await expect(frame.locator('body[data-ready="true"]')).toBeVisible();
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    const node = await iframe.elementHandle();
    const boot = await frame.locator("#boot").textContent();
    await frame.getByLabel("插件草稿").fill("仅原 iframe 中的草稿");
    await frame.getByRole("button", { name: "MessagePort ping" }).click();
    await expect(frame.locator("#replies")).toHaveText("1");
    await plugin
      .getByRole("button", { name: `最小化 ${name}`, exact: true })
      .dispatchEvent("click");
    await expect(plugin).toBeHidden();
    await expect(plugin).toHaveAttribute("inert", "");
    await page.locator(`[data-dock-app="plugin:${id}"]`).click();
    await activateGreen(plugin, name);
    // Fixture has already installed, booted and exchanged a genuine host RPC.
    await expectViewport(page, plugin);
    await titleAction(page, name, "显示桌面");
    const chat = await launch(page, "chat", "聊天");
    await activateGreen(chat, "聊天");
    await expect(plugin).toBeHidden();
    await expect(plugin).toHaveAttribute("aria-hidden", "true");
    expect(
      await iframe.evaluate((element, original) => element === original, node),
    ).toBe(true);
    await titleAction(page, "聊天", `切换到 ${name}`);
    await expectViewport(page, plugin);
    await expect(frame.getByLabel("插件草稿")).toHaveValue(
      "仅原 iframe 中的草稿",
    );
    await expect(frame.locator("#boot")).toHaveText(boot!);
    await expect(frame.locator("#boots")).toHaveText("1");
    await expect(frame.locator("#connections")).toHaveText("1");
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: size.height - 80 });
    await expectViewport(page, plugin);
    expect(
      await iframe.evaluate((element, original) => element === original, node),
    ).toBe(true);
    await frame.getByRole("button", { name: "MessagePort ping" }).click();
    await expect(frame.locator("#replies")).toHaveText("2");
    await frame.locator("#blank").click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await activateGreen(plugin, name);
    await plugin
      .getByRole("button", { name: `最小化 ${name}`, exact: true })
      .dispatchEvent("click");
    await page.locator(`[data-dock-app="plugin:${id}"]`).click();
    expect(
      await iframe.evaluate((element, original) => element === original, node),
    ).toBe(true);
    await frame.getByRole("button", { name: "MessagePort ping" }).click();
    await expect(frame.locator("#replies")).toHaveText("3");
    const windowId = await plugin.getAttribute("data-window-id");
    const closingFrame = plugin.evaluate(
      (element) =>
        new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (element.getAttribute("data-closing") !== "true") return;
            observer.disconnect();
            requestAnimationFrame(() =>
              resolve({
                connected: element.isConnected,
                inert: element.hasAttribute("inert"),
                hidden: element.getAttribute("aria-hidden"),
                interactive: element.getAttribute("data-interactive"),
              }),
            );
          });
          observer.observe(element, { attributes: true });
        }),
    );
    await plugin
      .getByRole("button", { name: `关闭 ${name}`, exact: true })
      .dispatchEvent("click");
    expect(await closingFrame).toEqual({
      connected: true,
      inert: true,
      hidden: "true",
      interactive: "false",
    });
    await expect(iframe).toHaveCount(0);
    await expect(page.locator(`[data-window-owner="${windowId}"]`)).toHaveCount(
      0,
    );
    expect(await node!.evaluate((element) => element.isConnected)).toBe(false);
    await node!.dispose();
    await launch(page, `plugin:${id}`, name);
    await expect(frame.locator('body[data-ready="true"]')).toBeVisible();
    expect(await frame.locator("#boot").textContent()).not.toBe(boot);
    await expect(frame.getByLabel("插件草稿")).toHaveValue("");
    await change(page, id, "disable");
    await expect(iframe).toHaveCount(0);
  } finally {
    await change(page, id, "disable");
    await change(page, id, "uninstall");
  }
});
