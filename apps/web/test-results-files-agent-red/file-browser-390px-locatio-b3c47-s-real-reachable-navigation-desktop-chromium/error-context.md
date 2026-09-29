# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: file-browser.spec.ts >> 390px locations drawer exposes real reachable navigation
- Location: e2e\file-browser.spec.ts:535:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('dialog', { name: '文件', exact: true }).getByRole('button', { name: '文件位置', exact: true })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('dialog', { name: '文件', exact: true }).getByRole('button', { name: '文件位置', exact: true })

```

```yaml
- button "系统状态"
- button "文件" [pressed]
- button "聊天"
- button "代码"
- button "任务"
- button "应用管理"
- button "设置"
- button "管理后台"
- dialog "文件":
  - button "关闭 文件":
    - img
  - button "最小化 文件":
    - img
  - button "最大化 文件":
    - img
  - text: 文件
  - button "后退" [disabled]:
    - img
  - button "前进" [disabled]:
    - img
  - button "上一级" [disabled]:
    - img
  - button "列表视图" [pressed]:
    - img
  - button "图标视图":
    - img
  - button "新建文件夹":
    - img
  - button "上传文件":
    - img
  - button "刷新":
    - img
  - button "更多操作":
    - img
  - textbox "搜索文件":
    - /placeholder: 搜索文件...
  - combobox "排序方式":
    - option "名称" [selected]
    - option "修改时间"
    - option "大小"
  - button "排序方向": 升序
  - navigation "文件路径":
    - button "共享根目录"
  - navigation "文件位置":
    - button "共享文件" [pressed]
    - button "最近文件"
    - button "本机历史"
    - button "传输队列"
  - img
  - paragraph: 此文件夹为空
  - paragraph: 拖入文件或点击上传
  - text: 0 / 0 个项目 已连接
  - button "选择要上传的文件"
- status "已连接工作区"
- button "系统状态"
- button "文件"
- button "聊天"
- button "代码"
- button "任务"
- button "应用管理"
- button "设置"
- button "管理后台"
- button "退出登录":
  - img
```

# Test source

```ts
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
  472 |   await expect(label).toHaveAttribute("title", name);
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
> 540 |   await expect(toggle).toBeVisible();
      |                        ^ Error: expect(locator).toBeVisible() failed
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
  573 | });
  574 | 
  575 | for (const rename of [false, true]) test(`invalid names validate while typing before submit (rename ${rename})`, async ({ page }) => {
  576 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("name", "有效名称", "file")]) }));
  577 |   const files = await openFiles(page);
  578 |   if (rename) {
  579 |     await files.getByRole("row", { name: "有效名称", exact: true }).press("F2");
  580 |   } else {
  581 |     await files.getByRole("button", { name: "新建文件夹", exact: true }).click();
  582 |   }
  583 |   const dialog = page.getByRole("dialog", { name: rename ? "重命名" : "新建文件夹", exact: true });
  584 |   const name = dialog.getByRole("textbox", { name: "名称", exact: true });
  585 |   const submit = dialog.getByRole("button", { name: rename ? "重命名" : "创建", exact: true });
  586 |   for (const invalid of ["bad/name", "..", " ", "长".repeat(86)]) {
  587 |     await name.fill(invalid);
  588 |     await expect(name).toHaveAttribute("aria-invalid", "true");
  589 |     await expect(dialog.getByRole("alert")).toBeVisible();
  590 |     await expect(submit).toBeDisabled();
  591 |   }
  592 |   await name.fill("有效新名称");
  593 |   await expect(name).toHaveAttribute("aria-invalid", "false");
  594 |   await expect(dialog.getByRole("alert")).toHaveCount(0);
  595 |   await expect(submit).toBeEnabled();
  596 | });
  597 | 
  598 | test("offline connection change preserves cached listing without failed refresh", async ({ page }) => {
  599 |   let socket!: WebSocketRoute;
  600 |   let offline = false;
  601 |   let offlineRequests = 0;
  602 |   await page.routeWebSocket("**/api/v1/ws?*", ws => { socket = ws; });
  603 |   await page.route("**/api/v1/resources?*", route => {
  604 |     if (offline) { offlineRequests++; return route.abort("internetdisconnected"); }
  605 |     return route.fulfill({ json: listing([resource("cached", "缓存文件", "file")]) });
  606 |   });
  607 |   const files = await openFiles(page);
  608 |   await expect(files.getByRole("row", { name: "缓存文件", exact: true })).toBeVisible();
  609 |   offline = true;
  610 |   await socket.close();
  611 |   await expect(files.getByRole("alert")).toHaveText(/网关离线/);
  612 |   await files.getByRole("button", { name: "图标视图", exact: true }).click();
  613 |   await files.getByRole("gridcell", { name: "缓存文件", exact: true }).click();
  614 |   await expect(files.getByRole("gridcell", { name: "缓存文件", exact: true })).toHaveAttribute("aria-selected", "true");
  615 |   await expect(files.getByRole("button", { name: "上传文件", exact: true })).toBeDisabled();
  616 |   await expect(files.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
  617 |   expect(offlineRequests).toBe(0);
  618 | });
  619 | 
```