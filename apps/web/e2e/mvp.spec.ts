import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, isMobile }, testInfo) => {
  test.skip(
    isMobile && testInfo.titlePath.includes("code save integrity"),
    "文件树仅在桌面布局可见",
  );
  await page.routeWebSocket(
    (url) => !url.pathname.startsWith("/api/v1/ws"),
    () => {},
  );
  await page.goto("/");
  await page.getByLabel("显示名").fill("E2E 管理员");
  await page
    .getByLabel(/口令/)
    .fill(process.env.LINKOS_E2E_ADMIN_PASSCODE ?? "linkos-admin");
  await page.getByRole("button", { name: "登录进入" }).click();
  await expect(
    page
      .locator(".desktop-icons")
      .getByRole("button", { name: "系统状态", exact: true }),
  ).toBeVisible();
});

async function openApp(page: import("@playwright/test").Page, name: string) {
  const icon = page
    .locator(".desktop-icons")
    .getByRole("button", { name, exact: true });
  if ((page.viewportSize()?.width ?? 1024) < 768) await icon.click();
  else await icon.dblclick();
}

test("chat search and message thread surface", async ({ page }) => {
  await openApp(page, "聊天");
  await expect(page.getByLabel("搜索消息")).toBeVisible();
  await page.getByLabel("消息输入").fill("playwright smoke message");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page.getByText("playwright smoke message").first(),
  ).toBeVisible();
});

test("code editor and administration load", async ({ page }) => {
  await openApp(page, "代码");
  await expect(page.getByLabel("代码编辑器")).toBeVisible();
  await page.getByRole("button", { name: "关闭 代码" }).dispatchEvent("click");
  await openApp(page, "管理后台");
  await expect(page.getByText("成员与设备")).toBeVisible();
  await expect(page.getByText("Runner", { exact: true })).toBeVisible();
});

async function createCodeFixture(
  page: import("@playwright/test").Page,
  content: string,
) {
  const token = await page.evaluate(() =>
    localStorage.getItem("linkos.access_token"),
  );
  const headers = { authorization: `Bearer ${token}` };
  const response = await page.request.post("/api/v1/code/files", {
    headers,
    data: {
      projectId: "project_gateway",
      path: `save-regression-${crypto.randomUUID()}.txt`,
      language: "text",
      content,
    },
  });
  expect(response.status()).toBe(201);
  const { file } = (await response.json()) as {
    file: { id: string; path: string; version: string };
  };
  return { file, headers };
}

async function selectCodeFile(
  page: import("@playwright/test").Page,
  path: string,
) {
  const code = page.getByRole("dialog", { name: "代码", exact: true });
  await code.getByRole("button", { name: path, exact: true }).dispatchEvent("click");
  await expect(code.locator(".cm-content")).toBeVisible();
  return code;
}

test.describe("code save integrity", () => {
  for (const lines of [2001, 2105]) {
    test(`truncated ${lines}-line preview cannot overwrite the full file`, async ({
      page,
    }) => {
      const content = Array.from(
        { length: lines },
        (_, index) => `line ${index + 1}`,
      ).join("\n");
      const { file, headers } = await createCodeFixture(page, content);
      await openApp(page, "代码");
      const code = await selectCodeFile(page, file.path);
      await expect(code.locator(".cm-content")).toHaveAttribute(
        "contenteditable",
        "false",
      );
      await expect(code.getByRole("alert")).toContainText(`共 ${lines} 行`);
      await expect(code.getByRole("alert")).toContainText("内容未完整加载");
      await expect(
        code.getByRole("button", { name: "保存", exact: true }),
      ).toBeDisabled();
      await expect(code.getByText("2000 lines", { exact: true })).toBeVisible();
      const response = await page.request.get(
        `/api/v1/code/files/${file.id}/versions`,
        { headers },
      );
      expect(response.ok()).toBeTruthy();
      const versions = await response.json();
      expect(versions.items).toHaveLength(1);
      expect(versions.items[0].content).toBe(content);
    });
  }

  test("truncated preview keeps an existing draft without restoring it into the editor", async ({
    page,
  }) => {
    const content = Array.from(
      { length: 2105 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    const { file, headers } = await createCodeFixture(page, content);
    const draftKey = await page.evaluate(
      ({ id, version }) => {
        const profile = JSON.parse(
          localStorage.getItem("linkos.access_profile")!,
        );
        return `linkos.code.draft.${JSON.stringify([localStorage.getItem("linkos.gateway_base") ?? "", profile.workspaceId, profile.userId])}.${id}.${version}`;
      },
      { id: file.id, version: file.version },
    );
    await page.evaluate(
      (key) => localStorage.setItem(key, "legacy partial draft"),
      draftKey,
    );
    await openApp(page, "代码");
    let code = await selectCodeFile(page, file.path);
    await expect(code.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await expect(code.locator(".cm-content")).not.toContainText(
      "legacy partial draft",
    );
    await expect(code.getByRole("alert")).toContainText(
      "本机草稿已保留，未自动恢复",
    );
    await expect(
      code.getByRole("button", { name: "保存", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), draftKey),
    ).toBe("legacy partial draft");
    await page.getByRole("button", { name: "关闭 代码", exact: true }).dispatchEvent("click");
    await expect(code).toHaveCount(0);
    await openApp(page, "代码");
    code = await selectCodeFile(page, file.path);
    await expect(
      code.getByRole("button", { name: "保存", exact: true }),
    ).toBeDisabled();
    const versions = await (
      await page.request.get(`/api/v1/code/files/${file.id}/versions`, {
        headers,
      })
    ).json();
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0].content).toBe(content);
  });

  test("complete 2000-line file stays editable after leaving a truncated preview", async ({
    page,
  }) => {
    const content = Array.from(
      { length: 2000 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    const long = await createCodeFixture(page, `${content}\nline 2001`);
    const short = await createCodeFixture(page, content);
    await openApp(page, "代码");
    await selectCodeFile(page, long.file.path);
    const code = await selectCodeFile(page, short.file.path);
    await expect(code.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "true",
    );
    await expect(code.getByRole("alert")).toHaveCount(0);
    await code.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.insertText("edited ");
    const saved = page.waitForResponse((response) =>
      response.url().includes(`${short.file.id}/save`),
    );
    await code.getByRole("button", { name: "保存", exact: true }).dispatchEvent("click");
    expect((await saved).status()).toBe(200);
    await expect(
      code.getByRole("button", { name: "保存", exact: true }),
    ).toBeDisabled();
    const versions = await (
      await page.request.get(`/api/v1/code/files/${short.file.id}/versions`, {
        headers: short.headers,
      })
    ).json();
    expect(versions.items).toHaveLength(2);
    expect(
      versions.items.find(
        (version: { version: string }) => version.version === "v2",
      ).content,
    ).toBe(`edited ${content}`);
    await selectCodeFile(page, long.file.path);
    await expect(code.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await expect(
      code.getByRole("button", { name: "保存", exact: true }),
    ).toBeDisabled();
  });

  test("save is disabled while another code file is loading", async ({
    page,
  }) => {
    const short = await createCodeFixture(page, "editable file");
    const long = await createCodeFixture(
      page,
      Array.from({ length: 2001 }, () => "long file").join("\n"),
    );
    await openApp(page, "代码");
    const code = await selectCodeFile(page, short.file.path);
    await code.locator(".cm-content").click();
    await page.keyboard.insertText("changed ");
    await expect(
      code.getByRole("button", { name: "保存", exact: true }),
    ).toBeEnabled();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/v1/code/files/${long.file.id}`, async (route) => {
      await blocked;
      await route.continue();
    });
    try {
      await code
        .getByRole("button", { name: long.file.path, exact: true })
        .dispatchEvent("click");
      await expect(
        code.getByText("加载代码...", { exact: true }),
      ).toBeVisible();
      await expect(
        code.getByRole("button", { name: "保存", exact: true }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await expect(code.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );
  });
});
