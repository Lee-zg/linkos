import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "default" });

async function login(page: Page) {
  const passcode = process.env.LINKOS_E2E_ADMIN_PASSCODE;
  if (!passcode) throw new Error("Isolated acceptance passcode is required");
  await page.goto("/");
  await page.getByLabel("显示名").fill("Dock Settings acceptance");
  await page.getByLabel(/口令/).fill(passcode);
  await page.getByRole("button", { name: "登录进入" }).click();
  await expect(page.locator(".desktop-icons")).toBeVisible();
}

test("dock is visible and has correct default position", async ({ page }) => {
  await login(page);
  const dock = page.locator(".desktop-dock-wrap");
  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute("data-position", "bottom");
});

test("settings app shows dock settings panel", async ({ page }) => {
  await login(page);
  await page.locator('[data-dock-app="settings"]').click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  // Dock settings panel should be present
  const dockPanel = settingsDialog.locator(".dock-settings-panel");
  await expect(dockPanel).toBeVisible();
});

test("dock settings icon size slider changes dock slot size", async ({
  page,
}) => {
  await login(page);
  await page.locator('[data-dock-app="settings"]').click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  // Find the icon size slider
  const slider = settingsDialog.getByLabel("图标尺寸");
  await expect(slider).toBeVisible();
  await slider.fill("64");
  // Assert the actual rendered size, not just that a slot still exists.
  await expect(page.locator(".desktop-dock")).toHaveCSS("--dock-slot-size", "64px");
  const dockSlot = page.locator(".dock-slot").first();
  await expect(dockSlot).toBeVisible();
});

test("dock settings position segmented control works", async ({ page }) => {
  await login(page);
  await page.locator('[data-dock-app="settings"]').click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  // Click "left" position option
  const leftButton = settingsDialog.getByRole("radio", { name: "左侧" });
  await leftButton.click();
  // The dock wrapper should now have data-position="left"
  const dock = page.locator(".desktop-dock-wrap");
  await expect(dock).toHaveAttribute("data-position", "left");
});

test("dock settings toggle auto-hide", async ({ page }) => {
  await login(page);
  await page.locator('[data-dock-app="settings"]').click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  // Find auto-hide toggle
  const autoHideToggle = settingsDialog.getByRole("switch", {
    name: "自动隐藏",
  });
  await expect(autoHideToggle).toBeVisible();
  await expect(autoHideToggle).toHaveAttribute("aria-checked", "false");
  await autoHideToggle.click();
  await expect(autoHideToggle).toHaveAttribute("aria-checked", "true");
});

test("dock settings toggle magnification", async ({ page }) => {
  await login(page);
  await page.locator('[data-dock-app="settings"]').click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  const magnificationToggle = settingsDialog.getByRole("switch", {
    name: "放大",
  });
  await expect(magnificationToggle).toBeVisible();
  // Default is on
  await expect(magnificationToggle).toHaveAttribute("aria-checked", "true");
  await magnificationToggle.click();
  await expect(magnificationToggle).toHaveAttribute("aria-checked", "false");
});

test("dock running indicators toggle", async ({ page }) => {
  await login(page);
  await page.locator('[data-dock-app="settings"]').click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  const toggle = settingsDialog.getByRole("switch", {
    name: "运行指示点",
  });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("dock minimize effect segmented control", async ({ page }) => {
  await login(page);
  await page.locator('[data-dock-app="settings"]').click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  // Default is genie
  const scaleButton = settingsDialog.getByRole("radio", { name: "缩放" });
  await scaleButton.click();
  // Verify the genie button is no longer active
  const genieButton = settingsDialog.getByRole("radio", { name: "精灵" });
  await expect(genieButton).toHaveAttribute("aria-checked", "false");
  await expect(scaleButton).toHaveAttribute("aria-checked", "true");
});

test("dock persists preferences across reload", async ({ page }) => {
  await login(page);
  await page.locator('[data-dock-app="settings"]').click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  // Change position to left
  await settingsDialog.getByRole("radio", { name: "左侧" }).click();
  await expect(page.locator(".desktop-dock-wrap")).toHaveAttribute(
    "data-position",
    "left",
  );
  // Reload and verify persistence
  await page.reload();
  await expect(page.locator(".desktop-icons")).toBeVisible();
  await expect(page.locator(".desktop-dock-wrap")).toHaveAttribute(
    "data-position",
    "left",
  );
});

for (const [position, label] of [["bottom", "底部"], ["left", "左侧"], ["right", "右侧"]]) {
  test(`auto-hide ${position}: edge hit, Portal hold, Escape focus, outside cancel and re-reveal`, async ({ page }) => {
    await login(page);
    await page.locator('[data-dock-app="settings"]').click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("radio", { name: label, exact: true }).click();
    await settings.getByRole("switch", { name: "自动隐藏", exact: true }).click();
    const dock = page.locator(".desktop-dock-wrap");
    const viewport = page.viewportSize()!;
    const outside = { x: viewport.width - 100, y: viewport.height - 150 };
    const edge = position === "bottom" ? { x: viewport.width / 2, y: viewport.height - 1 }
      : { x: position === "left" ? 1 : viewport.width - 1, y: viewport.height / 2 };
    await page.mouse.click(outside.x, outside.y);
    await expect(dock).toHaveAttribute("data-visible", "false");
    const reveal = async () => {
      await expect.poll(() => page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".dock-edge-trigger"), edge)).toBe(true);
      await page.mouse.move(edge.x, edge.y);
      await expect(dock).toHaveAttribute("data-visible", "true");
    };
    await reveal();
    // Leave while the reveal timer is still pending; it must not cancel hiding.
    await page.mouse.move(outside.x, outside.y);
    await expect(dock).toHaveAttribute("data-visible", "false");
    await reveal();
    const chat = page.locator('[data-dock-app="chat"]');
    await chat.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeFocused();
    await page.mouse.move(outside.x, outside.y);
    await page.waitForTimeout(350); // Exceed the hide/reveal timers while the Portal owns focus.
    await expect(menu).toBeVisible();
    await expect(dock).toHaveAttribute("data-visible", "true");
    await page.keyboard.press("Escape");
    await expect(chat).toBeFocused();
    await page.waitForTimeout(350);
    await expect(dock).toHaveAttribute("data-visible", "true");
    await page.keyboard.press(position === "bottom" ? "ArrowRight" : "ArrowDown");
    await expect(dock).toHaveAttribute("data-visible", "true");
    await page.mouse.click(outside.x, outside.y);
    await expect(dock).toHaveAttribute("data-visible", "false");
    await reveal();
    await chat.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.mouse.click(outside.x, outside.y);
    await expect(menu).toHaveCount(0);
    await expect(dock).toHaveAttribute("data-visible", "false");
    await reveal();
    await chat.click({ button: "right" });
    await expect(menu).toBeVisible();
    // Replace one Dock owner with another, then with a non-Dock owner.
    await page.locator('[data-dock-app="settings"]').click({ button: "right" });
    await expect(menu.getByRole("menuitem", { name: "显示窗口", exact: true })).toBeVisible();
    await page.mouse.move(outside.x, outside.y);
    await page.waitForTimeout(450);
    await expect(dock).toHaveAttribute("data-visible", "true");
    await settings.getByLabel("设置 标题栏", { exact: true }).click({ button: "right" });
    await expect(menu.getByRole("menuitem", { name: "Fill & Arrange", exact: true })).toBeVisible();
    await expect(dock).toHaveAttribute("data-visible", "false");
    await page.keyboard.press("Escape");
    await expect(settings.getByLabel("设置 标题栏", { exact: true })).toBeFocused();
    await reveal();
  });
}

// Headless Shell has no native tab focus; this lifecycle regression needs a
// real browser window, not dispatchEvent('blur') or a mocked document focus.
const nativeFocusTest = test.extend({ headless: false });
// Skip at registration time, before a headed browser fixture is launched.
const runNativeFocusTest = process.platform === "linux" && !process.env.DISPLAY
  ? nativeFocusTest.skip
  : nativeFocusTest;
runNativeFocusTest("real window blur clears Dock ownership and timers without restoring trigger focus", async ({ page, context }) => {
  // Playwright forces every Chromium page focused by default. Disable that
  // emulation so switching tabs delivers browser-generated, trusted blur/focus.
  await login(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await page.bringToFront();
  await page.locator('[data-dock-app="settings"]').click();
  await page.getByRole("dialog", { name: "设置", exact: true })
    .getByRole("switch", { name: "自动隐藏", exact: true }).click();
  const dock = page.locator(".desktop-dock-wrap");
  const viewport = page.viewportSize()!;
  const outside = { x: viewport.width - 100, y: viewport.height - 150 };
  await page.mouse.click(outside.x, outside.y);
  await expect(dock).toHaveAttribute("data-visible", "false");
  await page.mouse.move(viewport.width / 2, viewport.height - 1);
  await expect(dock).toHaveAttribute("data-visible", "true");
  await page.locator('[data-dock-app="chat"]').click({ button: "right" });
  await expect(page.getByRole("menu")).toBeFocused();
  await page.evaluate(() => {
    window.addEventListener("blur", event => {
      if (event.isTrusted) document.body.setAttribute("data-trusted-window-blur", "true");
    }, { once: true });
  });
  const other = await context.newPage();
  try {
    await other.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await expect(page.locator("body")).toHaveAttribute("data-trusted-window-blur", "true");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(dock).toHaveAttribute("data-interaction-state", "edge");
    await page.waitForTimeout(450);
    await expect(dock).toHaveAttribute("data-visible", "false");
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await expect(page.locator('[data-dock-app="chat"]')).not.toBeFocused();
    await page.mouse.move(outside.x, outside.y);
    await page.mouse.move(viewport.width / 2, viewport.height - 1);
    await expect(dock).toHaveAttribute("data-visible", "true");
    await page.mouse.move(outside.x, outside.y);
    await expect(dock).toHaveAttribute("data-visible", "false");
  } finally {
    await other.close();
    await cdp.detach();
  }
});

for (const [position, label] of [["bottom", "底部"], ["left", "左侧"], ["right", "右侧"]]) {
  test(`inactive desktop ${position}: no edge hotspot or active Dock menu scope`, async ({ page }) => {
    await login(page);
    await page.locator('[data-dock-app="settings"]').click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("radio", { name: label, exact: true }).click();
    await settings.getByRole("switch", { name: "自动隐藏", exact: true }).click();
    await settings.getByRole("button", { name: "进入全屏 设置", exact: true }).click();
    await expect(settings).toHaveAttribute("data-space-type", "fullscreen");
    const dock = page.locator(".desktop-dock-wrap");
    await expect(dock).toHaveAttribute("inert", "");
    await expect(dock).toHaveAttribute("data-visible", "false");
    await expect(page.locator(".dock-edge-trigger")).toHaveCount(0);
    const viewport = page.viewportSize()!;
    const edge = position === "bottom" ? { x: viewport.width / 2, y: viewport.height - 1 }
      : { x: position === "left" ? 1 : viewport.width - 1, y: viewport.height / 2 };
    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(450);
    await expect(dock).toHaveAttribute("data-visible", "false");
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".desktop-dock-wrap, .dock-edge-trigger"), edge)).toBe(false);
    const chat = page.locator('[data-dock-app="chat"]');
    await chat.focus();
    await expect(chat).not.toBeFocused();
    // Negative routing probe only: a stale event on inert DOM must not register a menu.
    // Every positive hit/open above uses real pointer/keyboard input, never dispatch/force.
    await chat.dispatchEvent("contextmenu");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await settings.getByRole("button", { name: "退出全屏 设置", exact: true }).click();
    await expect(page.locator(".dock-edge-trigger")).toHaveCount(1);
    await page.mouse.move(edge.x, edge.y);
    await expect(dock).toHaveAttribute("data-visible", "true");
    await chat.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "从 Dock 移除", exact: true })).toBeVisible();
  });
}
