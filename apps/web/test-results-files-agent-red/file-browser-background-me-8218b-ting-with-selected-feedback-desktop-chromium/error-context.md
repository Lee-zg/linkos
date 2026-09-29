# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: file-browser.spec.ts >> background menu changes view and server sorting with selected feedback
- Location: e2e\file-browser.spec.ts:419:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('menuitem', { name: /列表视图.*已选中/ })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('menuitem', { name: /列表视图.*已选中/ })

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
  - grid "文件列表":
    - button "名称 ↑"
    - button "修改时间"
    - button "大小"
    - row "name-asc":
      - img
      - text: name-asc 2026/1/1 0 B
      - button "更多操作 name-asc":
        - img
  - text: 1 / 1 个项目 已连接
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
- menu:
  - menuitem "新建文件夹":
    - img
    - text: 新建文件夹
  - menuitem "上传文件":
    - img
    - text: 上传文件
  - menuitem "刷新":
    - img
    - text: 刷新
```

# Test source

```ts
  328 |   ]);
  329 |   await firstStarted;
  330 |   await openFolder(page, "目标目录");
  331 |   await expect(files.getByText("目标内容", { exact: true })).toBeVisible();
  332 |   release();
  333 |   await expect.poll(() => destinations.length).toBe(2);
  334 |   await expect(page.getByText("two.txt 上传完成", { exact: true })).toBeVisible();
  335 |   expect(destinations).toEqual(["", ""]);
  336 |   await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("目标目录");
  337 |   await expect(files.getByText("目标内容", { exact: true })).toBeVisible();
  338 | });
  339 | 
  340 | test("Enter, Shift F10 and Delete share the object commands", async ({ page }) => {
  341 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("parentId") === "keyboard" ? listing([resource("keyfile", "键盘文件", "file")], { ancestors: [{ id: "keyboard", name: "键盘目录" }] }) : listing([resource("keyboard", "键盘目录")]) }));
  342 |   const files = await openFiles(page);
  343 |   const folder = files.getByRole("row", { name: "键盘目录", exact: true });
  344 |   await folder.focus();
  345 |   await folder.press("Enter");
  346 |   const file = files.getByRole("row", { name: "键盘文件", exact: true });
  347 |   await file.focus();
  348 |   await file.press("Shift+F10");
  349 |   await expect(page.getByRole("menuitem", { name: "下载", exact: true })).toBeVisible();
  350 |   await page.keyboard.press("Escape");
  351 |   await expect(file).toBeFocused();
  352 |   await file.press("Delete");
  353 |   await expect(page.getByRole("alertdialog", { name: "确认删除" })).toBeVisible();
  354 |   await page.keyboard.press("Escape");
  355 |   await expect(file).toBeFocused();
  356 | });
  357 | 
  358 | test("information resolves the real resource path rather than visit history", async ({ page }) => {
  359 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("parentId") === "real-parent" ? listing([], { ancestors: [{ id: "real-parent", name: "真实父目录" }] }) : listing([resource("info-file", "简介文件", "file")]) }));
  360 |   await page.route("**/api/v1/resources/info-file", route => route.fulfill({ json: resource("info-file", "简介文件", "file", { parentId: "real-parent" }) }));
  361 |   const files = await openFiles(page);
  362 |   await files.getByRole("button", { name: "更多操作 简介文件", exact: true }).click();
  363 |   await page.getByRole("menuitem", { name: "显示简介", exact: true }).click();
  364 |   const info = page.getByRole("dialog", { name: "显示简介", exact: true });
  365 |   await expect(info).toContainText("共享根目录 / 真实父目录 / 简介文件");
  366 | });
  367 | 
  368 | test("live gateway create rename and remote removal honor the file contract", async ({ page }) => {
  369 |   const files = await openFiles(page);
  370 |   const token = await page.evaluate(() => localStorage.getItem("linkos.access_token"));
  371 |   const headers = { authorization: `Bearer ${token}` };
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
> 428 |   await expect(page.getByRole("menuitem", { name: /列表视图.*已选中/ })).toBeVisible();
      |                                                                   ^ Error: expect(locator).toBeVisible() failed
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
```