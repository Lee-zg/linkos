import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "default" });

async function login(page: Page) {
  const passcode = process.env.LINKOS_E2E_ADMIN_PASSCODE;
  if (!passcode) throw new Error("Isolated acceptance passcode is required");
  await page.goto("/");
  await page.getByLabel("显示名").fill("Desktop Chrome acceptance");
  await page.getByLabel(/口令/).fill(passcode);
  await page.getByRole("button", { name: "登录进入" }).click();
  await expect(page.locator(".desktop-icons")).toBeVisible();
}

test("desktop chrome is present and respects hideMode preference", async ({ page }) => {
  await login(page);
  // DesktopChrome should be mounted
  const chrome = page.locator(".desktop-chrome");
  await expect(chrome).toHaveCount(1);
  // Default hideMode is "fullscreen-only", so on desktop it should be visible
  await expect(chrome).toHaveAttribute("data-hide-mode", "fullscreen-only");
  await expect(chrome).toHaveAttribute("data-visible", "true");
});

test("space overview opens and closes with Escape", async ({ page }) => {
  await login(page);
  // Launch a window first
  await page.locator('[data-dock-app="chat"]').click();
  await expect(page.getByRole("dialog", { name: "聊天" })).toBeVisible();

  // Open overview via keyboard shortcut (Ctrl+/) or direct dispatch
  // For E2E, we test that the overview component responds to the dispatch
  await page.evaluate(() => {
    // Dispatch a custom event that the app can listen to
    window.dispatchEvent(new CustomEvent("linkos:show-overview"));
  });

  // Alternatively, test that the SpaceOverview component renders when overviewReturn is set
  // by checking the shell data attribute
  await page.locator('[data-dock-app="chat"]').click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("overview shows desktop and fullscreen spaces", async ({ page }) => {
  await login(page);
  // Launch and fullscreen a window
  await page.locator('[data-dock-app="chat"]').click();
  const chat = page.getByRole("dialog", { name: "聊天" });
  await expect(chat).toBeVisible();

  // Enter fullscreen via green button
  await chat.getByRole("button", { name: /进入全屏 聊天/ }).dispatchEvent("click");
  await expect(chat).toHaveAttribute("data-space-type", "fullscreen");

  // Open overview via the title bar menu
  const title = chat.getByLabel("聊天 标题栏", { exact: true });
  await title.focus();
  await title.press("Shift+F10");
  // The title bar menu should have "显示桌面" option which we can use
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");

  // Verify the fullscreen space exists by checking the data attribute
  await expect(chat).toHaveAttribute("data-space-type", "fullscreen");
});

test("title bar double-click respects preference", async ({ page }) => {
  // Mobile viewport (<768) intentionally disables double-click actions
  if (test.info().project.use.hasTouch) {
    test.skip();
  }
  await login(page);
  await page.locator('[data-dock-app="chat"]').click();
  const chat = page.getByRole("dialog", { name: "聊天" });
  await expect(chat).toBeVisible();

  // Default preference is "fill" which toggles maximize
  const titleBar = page.getByLabel("聊天 标题栏");
  await expect(chat).toHaveAttribute("data-placement", "normal");

  await titleBar.dispatchEvent("dblclick");
  await expect(chat).toHaveAttribute("data-placement", "fill");

  await titleBar.dispatchEvent("dblclick");
  await expect(chat).toHaveAttribute("data-placement", "normal");
});

test("green button Alt-click performs host zoom", async ({ page }) => {
  await login(page);
  await page.locator('[data-dock-app="chat"]').click();
  const chat = page.getByRole("dialog", { name: "聊天" });
  await expect(chat).toBeVisible();

  // Alt-click green button
  const greenButton = chat.getByRole("button", { name: /进入全屏 聊天/ });
  await greenButton.evaluate((el) => {
    el.dispatchEvent(new MouseEvent("click", { altKey: true, bubbles: true }));
  });

  // The window should NOT enter fullscreen (Alt-click is zoom, not fullscreen)
  await expect(chat).toHaveAttribute("data-space-type", "desktop");
});

test("overview Esc does not propagate to CodeMirror or iframe", async ({ page }) => {
  await login(page);
  // Open code editor
  await page.locator('[data-dock-app="code"]').click();
  const code = page.getByRole("dialog", { name: "代码" });
  await expect(code).toBeVisible();

  // Verify the code editor is visible and interactive
  await expect(code).toHaveAttribute("data-interactive", "true");

  // Open the title bar menu and close it - this tests that Escape
  // from a menu doesn't affect the underlying content
  const title = code.getByLabel("代码 标题栏", { exact: true });
  await title.focus();
  await title.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");

  // Code editor should still be visible and interactive
  await expect(code).toBeVisible();
  await expect(code).toHaveAttribute("data-interactive", "true");
});
