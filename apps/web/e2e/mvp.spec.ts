import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("显示名").fill("E2E 管理员");
  await page.getByLabel(/口令/).fill(process.env.LINKOS_E2E_ADMIN_PASSCODE ?? "linkos-admin");
  await page.getByRole("button", { name: "登录进入" }).click();
  await expect(page.getByText("系统状态", { exact: true })).toBeVisible();
});

async function openApp(page: import("@playwright/test").Page, name: string) {
  const icon = page.getByText(name, { exact: true }).first();
  if ((page.viewportSize()?.width ?? 1024) < 768) await icon.click(); else await icon.dblclick();
}

test("chat search and message thread surface", async ({ page }) => {
  await openApp(page, "聊天");
  await expect(page.getByLabel("搜索消息")).toBeVisible();
  await page.getByPlaceholder(/发送到/).fill("playwright smoke message");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("playwright smoke message").first()).toBeVisible();
});

test("code editor and administration load", async ({ page }) => {
  await openApp(page, "代码");
  await expect(page.getByLabel("代码编辑器")).toBeVisible();
  await page.getByRole("button", { name: "关闭 代码" }).click();
  await openApp(page, "管理后台");
  await expect(page.getByText("成员与设备")).toBeVisible();
  await expect(page.getByText("Runner", { exact: true })).toBeVisible();
});
