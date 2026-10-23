import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "default" });

async function login(page: Page) {
  const passcode = process.env.LINKOS_E2E_ADMIN_PASSCODE;
  if (!passcode) throw new Error("Isolated acceptance passcode is required");
  await page.goto("/");
  await page.getByLabel("显示名").fill("Desktop without top menu acceptance");
  await page.getByLabel(/口令/).fill(passcode);
  await page.getByRole("button", { name: "登录进入" }).click();
  await expect(page.locator(".desktop-icons")).toBeVisible();
}

async function expectNoTopMenu(page: Page) {
  await expect(page.getByRole("menubar", { includeHidden: true })).toHaveCount(0);
  await expect(page.locator(".desktop-chrome, .desktop-chrome-edge-trigger, .desktop-chrome-entry")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "显示桌面菜单栏", includeHidden: true })).toHaveCount(0);
}

test("desktop has no top menu, hotspot or reserved gap even with legacy menu-bar preferences", async ({ page }) => {
  await login(page);
  await expectNoTopMenu(page);
  for (const hideMode of ["never", "always", "desktop-only", "fullscreen-only"]) {
    await page.evaluate((hideMode) => {
      const key = Object.keys(localStorage).find(key => key.startsWith("linkos.desktop-preferences:"))!;
      const prefs = JSON.parse(localStorage.getItem(key)!);
      prefs.menuBar = { hideMode, showBackground: true };
      localStorage.setItem(key, JSON.stringify(prefs));
    }, hideMode);
    await page.reload();
    await expect(page.locator(".desktop-icons")).toBeVisible();
    await page.mouse.move(300, 1);
    await expectNoTopMenu(page);
    await page.locator('[data-dock-app="chat"]').click();
    const chat = page.getByRole("dialog", { name: "聊天", exact: true });
    await chat.getByLabel("聊天 标题栏", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "填充", exact: true }).click();
    await expect.poll(async () => (await chat.boundingBox())?.y).toBe(0);
    await chat.getByRole("button", { name: "进入全屏 聊天", exact: true }).click();
    await expect(chat).toHaveAttribute("data-space-type", "fullscreen");
    await page.mouse.move(300, 1);
    await expectNoTopMenu(page);
    await chat.getByRole("button", { name: "退出全屏 聊天", exact: true }).click();
    await chat.getByRole("button", { name: "关闭 聊天", exact: true }).click();
    await expect(chat).toHaveCount(0);
  }
});

test("Mission Control remains reachable through context menus without a top bar", async ({ page }) => {
  await login(page);
  const viewport = page.viewportSize()!;
  await page.locator(".wallpaper").click({
    button: "right",
    position: { x: viewport.width - 30, y: viewport.height / 2 },
  });
  await page.getByRole("menuitem", { name: "Mission Control", exact: true }).click();
  let panel = page.getByRole("dialog", { name: "Mission Control", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-space-id="desktop"]')).toContainText("桌面");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.locator('[data-dock-app="chat"]').click();
  const chat = page.getByRole("dialog", { name: "聊天", exact: true, includeHidden: true });
  await chat.getByRole("button", { name: "进入全屏 聊天", exact: true }).click();
  const spaceId = await chat.getAttribute("data-space-id");
  const showOverview = async () => {
    await chat.getByLabel("聊天 标题栏", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mission Control", exact: true }).click();
    const overview = page.getByRole("dialog", { name: "Mission Control", exact: true });
    await expect(overview).toBeVisible();
    return overview;
  };
  panel = await showOverview();
  await expect(panel.locator('[data-space-type="fullscreen"]')).toContainText("聊天");
  await expect(panel.locator('[data-space-type="fullscreen"]')).toHaveClass(/is-current/);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(chat).toHaveAttribute("data-visible", "true");
  await expect(chat).toHaveAttribute("data-space-id", spaceId!);
  panel = await showOverview();
  await panel.locator('[data-space-id="desktop"]').click();
  await expect(panel).toHaveCount(0);
  await expect(chat).toHaveAttribute("data-visible", "false");
  await expect(page.locator(".desktop-icons")).toBeVisible();
  await expectNoTopMenu(page);
});

test("title double-click and Alt-green zoom use real pointer actions", async ({ page, isMobile }) => {
  test.skip(isMobile, "标题栏双击仅在桌面布局启用");
  await login(page);
  await page.locator('[data-dock-app="chat"]').click();
  const chat = page.getByRole("dialog", { name: "聊天", exact: true });
  const title = chat.getByLabel("聊天 标题栏", { exact: true });
  await expect(chat).toHaveAttribute("data-placement", "normal");
  await title.dblclick({ position: { x: 180, y: 18 } });
  await expect(chat).toHaveAttribute("data-placement", "fill");
  await title.dblclick({ position: { x: 180, y: 18 } });
  await expect(chat).toHaveAttribute("data-placement", "normal");
  await chat.getByRole("button", { name: "进入全屏 聊天", exact: true }).click({ modifiers: ["Alt"] });
  await expect(chat).toHaveAttribute("data-space-type", "desktop");
  await expect(page.locator("html")).toHaveCSS("zoom", "1.25");
});
