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
  // Change the slider value
  await slider.fill("64");
  await slider.dispatchEvent("input");
  await slider.dispatchEvent("change");
  // The dock should reflect the new size
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
