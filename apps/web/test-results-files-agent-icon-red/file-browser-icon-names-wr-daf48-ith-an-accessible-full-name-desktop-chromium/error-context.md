# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: file-browser.spec.ts >> icon names wrap to two lines with an accessible full name
- Location: e2e\file-browser.spec.ts:464:1

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator:  getByRole('dialog', { name: '文件', exact: true }).getByRole('gridcell', { name: '季度财务分析及文件归档清单最终审核版本.pdf', exact: true }).getByText('季度财务分析及文件归档清单最终审核版本.pdf', { exact: true })
Expected: "季度财务分析及文件归档清单最终审核版本.pdf"
Received: ""
Timeout:  5000ms

Call log:
  - Expect "toHaveAttribute" with timeout 5000ms
  - waiting for getByRole('dialog', { name: '文件', exact: true }).getByRole('gridcell', { name: '季度财务分析及文件归档清单最终审核版本.pdf', exact: true }).getByText('季度财务分析及文件归档清单最终审核版本.pdf', { exact: true })
    14 × locator resolved to <span class="min-w-0 truncate w-full text-center text-xs">季度财务分析及文件归档清单最终审核版本.pdf</span>
       - unexpected value "null"

```

```yaml
- text: 季度财务分析及文件归档清单最终审核版本.pdf
```

# Test source

```ts
  372 |   const rootName = `000-f3-${crypto.randomUUID()}`;
  373 |   const response = await page.request.post("/api/v1/resources", { headers, data: { type: "folder", name: rootName, parentId: "" } });
  374 |   expect(response.status()).toBe(201);
  375 |   const root = await response.json();
  376 |   try {
  377 |     const contract = await (await page.request.get(`/api/v1/resources?scope=files&parentId=${root.id}`, { headers })).json();
  378 |     expect(contract, "live gateway must expose the F3 directory contract").toMatchObject({ ancestors: [{ id: root.id, name: rootName }], canRead: true, canWrite: true, canCreateChild: true, total: 0 });
  379 |     await files.getByRole("textbox", { name: "搜索文件" }).fill(rootName);
  380 |     await openFolder(page, rootName);
  381 |     await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText(rootName);
  382 |     await files.getByRole("button", { name: "新建文件夹", exact: true }).click();
  383 |     const form = page.getByRole("dialog", { name: "新建文件夹", exact: true });
  384 |     await form.getByRole("textbox", { name: "名称", exact: true }).fill("子目录");
  385 |     await form.getByRole("button", { name: "创建", exact: true }).click();
  386 |     const child = files.getByRole("row", { name: "子目录", exact: true });
  387 |     await expect(child).toBeVisible();
  388 |     await child.focus();
  389 |     await child.press("F2");
  390 |     const rename = page.getByRole("dialog", { name: "重命名", exact: true });
  391 |     await rename.getByRole("textbox", { name: "名称", exact: true }).fill("已重命名");
  392 |     await rename.getByRole("button", { name: "重命名", exact: true }).click();
  393 |     await expect(files.getByRole("row", { name: "已重命名", exact: true })).toBeVisible();
  394 |     const childId = await files.getByRole("row", { name: "已重命名", exact: true }).getAttribute("data-resource-id");
  395 |     await openFolder(page, "已重命名");
  396 |     await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("已重命名");
  397 |     const removed = await page.request.delete(`/api/v1/resources/${childId}?recursive=true`, { headers });
  398 |     expect(removed.ok()).toBe(true);
  399 |     await expect(files.getByRole("status")).toContainText("已返回");
  400 |     await expect(files.getByRole("navigation", { name: "文件路径" })).not.toContainText("已重命名");
  401 |     await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText(rootName);
  402 |   } finally {
  403 |     await page.request.delete(`/api/v1/resources/${root.id}?recursive=true`, { headers });
  404 |   }
  405 | });
  406 | 
  407 | test("mobile objects have reachable menus, single tap folders, and no 390px overflow", async ({ page }) => {
  408 |   await page.setViewportSize({ width: 390, height: 844 });
  409 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("parentId") === "mobile" ? listing([], { ancestors: [{ id: "mobile", name: "手机目录" }] }) : listing([resource("mobile", "手机目录")]) }));
  410 |   const files = await openFiles(page);
  411 |   await expect(files.getByRole("button", { name: "更多操作 手机目录", exact: true })).toBeVisible();
  412 |   await openFolder(page, "手机目录");
  413 |   await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("手机目录");
  414 |   expect(await files.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  415 |   await files.getByRole("button", { name: "文件位置", exact: true }).click();
  416 |   await expect(files.getByRole("button", { name: "本机历史", exact: true })).toBeVisible();
  417 | });
  418 | 
  419 | test("background menu changes view and server sorting with selected feedback", async ({ page }) => {
  420 |   await page.route("**/api/v1/resources?*", route => {
  421 |     const params = new URL(route.request().url()).searchParams;
  422 |     return route.fulfill({ json: listing([resource("sorted", `${params.get("sortBy")}-${params.get("sortOrder")}`, "file")]) });
  423 |   });
  424 |   const files = await openFiles(page);
  425 |   const content = files.getByLabel("文件内容", { exact: true });
  426 |   const background = { position: { x: 4, y: 200 }, button: "right" as const };
  427 |   await content.click(background);
  428 |   await expect(page.getByRole("menuitem", { name: /列表视图.*已选中/ })).toBeVisible();
  429 |   await page.getByRole("menuitem", { name: "图标视图", exact: true }).click();
  430 |   await expect(files.getByRole("gridcell", { name: "name-asc", exact: true })).toBeVisible();
  431 |   await content.click(background);
  432 |   await expect(page.getByRole("menuitem", { name: /图标视图.*已选中/ })).toBeVisible();
  433 |   await page.getByRole("menuitem", { name: "列表视图", exact: true }).click();
  434 |   for (const [label, field] of [["修改时间", "updatedAt"], ["大小", "size"], ["名称", "name"]]) {
  435 |     await content.click(background);
  436 |     await page.getByRole("menuitem", { name: `按${label}排序`, exact: true }).click();
  437 |     await expect(files.getByRole("row", { name: `${field}-asc`, exact: true })).toBeVisible();
  438 |     await files.getByRole("button", { name: "更多操作", exact: true }).click();
  439 |     await page.getByRole("menuitem", { name: `按${label}排序（升序）`, exact: true }).click();
  440 |     await expect(files.getByRole("row", { name: `${field}-desc`, exact: true })).toBeVisible();
  441 |     await content.click(background);
  442 |     await expect(page.getByRole("menuitem", { name: `按${label}排序（降序）`, exact: true })).toBeVisible();
  443 |     await page.keyboard.press("Escape");
  444 |   }
  445 | });
  446 | 
  447 | test("only blank content clicks clear file selection", async ({ page }) => {
  448 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("select", "可选择文件", "file")]) }));
  449 |   const files = await openFiles(page);
  450 |   const item = files.getByRole("row", { name: "可选择文件", exact: true });
  451 |   await item.getByText("可选择文件", { exact: true }).click();
  452 |   await expect(item).toHaveAttribute("aria-selected", "true");
  453 |   await files.getByRole("button", { name: "更多操作 可选择文件", exact: true }).click();
  454 |   await page.keyboard.press("Escape");
  455 |   await expect(item).toHaveAttribute("aria-selected", "true");
  456 |   await files.getByRole("button", { name: "列表视图", exact: true }).click();
  457 |   await expect(item).toHaveAttribute("aria-selected", "true");
  458 |   await files.getByLabel("文件内容", { exact: true }).click({ position: { x: 4, y: 200 } });
  459 |   await expect(item).toHaveAttribute("aria-selected", "false");
  460 |   await page.keyboard.press("Delete");
  461 |   await expect(page.getByRole("alertdialog")).toHaveCount(0);
  462 | });
  463 | 
  464 | test("icon names wrap to two lines with an accessible full name", async ({ page }) => {
  465 |   const name = "季度财务分析及文件归档清单最终审核版本.pdf";
  466 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("long", name, "file")]) }));
  467 |   const files = await openFiles(page);
  468 |   await files.getByRole("button", { name: "图标视图" }).click();
  469 |   const item = files.getByRole("gridcell", { name, exact: true });
  470 |   await expect(item).toBeVisible();
  471 |   const label = item.getByText(name, { exact: true });
> 472 |   await expect(label).toHaveAttribute("title", name);
      |                       ^ Error: expect(locator).toHaveAttribute(expected) failed
  473 |   await expect(label).toHaveCSS("-webkit-line-clamp", "2");
  474 |   await expect(label).not.toHaveCSS("white-space", "nowrap");
  475 | });
  476 | 
  477 | test("list has separate type and size columns", async ({ page }) => {
  478 |   await page.setViewportSize({ width: 1280, height: 900 });
  479 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("folder", "类型目录"), resource("file", "类型文件", "file", { meta: { size: 2048 } })]) }));
  480 |   const files = await openFiles(page);
  481 |   await expect(files.getByRole("columnheader", { name: "类型", exact: true })).toBeVisible();
  482 |   const folder = files.getByRole("row", { name: "类型目录", exact: true });
  483 |   await expect(folder.getByRole("gridcell", { name: "文件夹", exact: true })).toBeVisible();
  484 |   await expect(folder.getByRole("gridcell", { name: "—", exact: true })).toBeVisible();
  485 |   const file = files.getByRole("row", { name: "类型文件", exact: true });
  486 |   await expect(file.getByRole("gridcell", { name: "文件", exact: true })).toBeVisible();
  487 |   await expect(file.getByRole("gridcell", { name: "2.0 KB", exact: true })).toBeVisible();
  488 | });
  489 | 
  490 | for (const empty of [false, true]) test(`initial skeleton becomes nonblocking refresh feedback (empty ${empty})`, async ({ page }) => {
  491 |   let release!: () => void;
  492 |   let gate = new Promise<void>(resolve => { release = resolve; });
  493 |   await page.route("**/api/v1/resources?*", async route => {
  494 |     await gate;
  495 |     await route.fulfill({ json: listing(empty ? [] : [resource("refresh", "保留内容", "file")]) });
  496 |   });
  497 |   const files = await openFiles(page);
  498 |   const skeleton = files.getByRole("status", { name: "文件列表加载中", exact: true });
  499 |   await expect(skeleton).toBeVisible();
  500 |   await expect(skeleton.locator(".animate-pulse")).not.toHaveCount(0);
  501 |   release();
  502 |   const content = empty ? files.getByText("此文件夹为空", { exact: true }) : files.getByRole("row", { name: "保留内容", exact: true });
  503 |   await expect(content).toBeVisible();
  504 |   if (!empty) await content.click();
  505 |   gate = new Promise<void>(resolve => { release = resolve; });
  506 |   await files.getByRole("button", { name: "刷新", exact: true }).click();
  507 |   await expect(files.getByRole("status", { name: "正在刷新文件", exact: true })).toBeVisible();
  508 |   await expect(skeleton).toHaveCount(0);
  509 |   await expect(content).toBeVisible();
  510 |   await expect(files.getByRole("textbox", { name: "搜索文件" })).toBeEnabled();
  511 |   if (!empty) await expect(content).toHaveAttribute("aria-selected", "true");
  512 |   release();
  513 |   await expect(files.getByRole("status", { name: "正在刷新文件", exact: true })).toHaveCount(0);
  514 | });
  515 | 
  516 | test("directory title and bottom path follow server ancestry", async ({ page }) => {
  517 |   await page.route("**/api/v1/resources?*", route => {
  518 |     const parent = new URL(route.request().url()).searchParams.get("parentId");
  519 |     return route.fulfill({ json: parent === "nested" ? listing([], { ancestors: [{ id: "real", name: "真正上级" }, { id: "nested", name: "标题目录" }] }) : listing([resource("nested", "标题目录")]) });
  520 |   });
  521 |   const files = await openFiles(page);
  522 |   await expect(files.getByRole("heading", { name: "共享根目录", exact: true })).toBeVisible();
  523 |   await openFolder(page, "标题目录");
  524 |   await expect(files.getByRole("heading", { name: "标题目录", exact: true })).toBeVisible();
  525 |   const path = files.getByRole("navigation", { name: "文件路径", exact: true });
  526 |   await expect(path).toContainText("真正上级");
  527 |   const contentBox = await files.getByLabel("文件内容", { exact: true }).boundingBox();
  528 |   const pathBox = await path.boundingBox();
  529 |   expect(pathBox!.y).toBeGreaterThanOrEqual(contentBox!.y + contentBox!.height - 1);
  530 |   const request = page.waitForRequest(req => new URL(req.url()).searchParams.get("parentId") === "real");
  531 |   await path.getByRole("button", { name: "真正上级", exact: true }).click();
  532 |   await request;
  533 | });
  534 | 
  535 | test("390px locations drawer exposes real reachable navigation", async ({ page }) => {
  536 |   await page.setViewportSize({ width: 390, height: 844 });
  537 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([]) }));
  538 |   const files = await openFiles(page);
  539 |   const toggle = files.getByRole("button", { name: "文件位置", exact: true });
  540 |   await expect(toggle).toBeVisible();
  541 |   await expect(toggle).toHaveAttribute("aria-expanded", "false");
  542 |   await expect(files.getByRole("button", { name: "最近文件", exact: true })).toHaveCount(0);
  543 |   await toggle.click();
  544 |   await expect(toggle).toHaveAttribute("aria-expanded", "true");
  545 |   await expect(files.getByRole("navigation", { name: "文件位置", exact: true })).toBeVisible();
  546 |   await files.getByRole("button", { name: "最近文件", exact: true }).click();
  547 |   await expect(files.getByText("暂无最近文件", { exact: true })).toBeVisible();
  548 |   await expect(toggle).toHaveAttribute("aria-expanded", "false");
  549 |   await toggle.click();
  550 |   await files.getByRole("button", { name: "本机历史", exact: true }).click();
  551 |   await expect(files.getByText("暂无本机历史", { exact: true })).toBeVisible();
  552 |   await toggle.click();
  553 |   await page.keyboard.press("Escape");
  554 |   await expect(toggle).toHaveAttribute("aria-expanded", "false");
  555 |   await expect(toggle).toBeFocused();
  556 |   expect(await files.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  557 | });
  558 | 
  559 | test("delete starts on cancel and Enter safely cancels", async ({ page }) => {
  560 |   let deletes = 0;
  561 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("safe", "安全删除", "file")]) }));
  562 |   await page.route("**/api/v1/resources/safe?*", route => { deletes++; return route.fulfill({ json: {} }); });
  563 |   const files = await openFiles(page);
  564 |   const item = files.getByRole("row", { name: "安全删除", exact: true });
  565 |   await item.focus();
  566 |   await item.press("Delete");
  567 |   const dialog = page.getByRole("alertdialog", { name: "确认删除" });
  568 |   await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  569 |   await page.keyboard.press("Enter");
  570 |   await expect(dialog).toHaveCount(0);
  571 |   await expect(item).toBeFocused();
  572 |   expect(deletes).toBe(0);
```