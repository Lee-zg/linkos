# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: file-browser.spec.ts >> upload completion refreshes current navigation and retains one batch destination
- Location: e2e\file-browser.spec.ts:297:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('two.txt 上传完成', { exact: true })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByText('two.txt 上传完成', { exact: true })

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
  - button "后退":
    - img
  - button "前进" [disabled]:
    - img
  - button "上一级":
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
    - img
    - button "目标目录"
  - navigation "文件位置":
    - button "共享文件" [pressed]
    - button "最近文件"
    - button "本机历史"
    - button "传输队列"
  - grid "文件列表":
    - button "名称 ↑"
    - row "目标内容":
      - img
      - text: 目标内容
      - button "更多操作 目标内容":
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
```

# Test source

```ts
  228 | });
  229 | 
  230 | test("offline double click does not download cached files", async ({ page }) => {
  231 |   let socket!: WebSocketRoute;
  232 |   let downloads = 0;
  233 |   await page.routeWebSocket("**/api/v1/ws?*", ws => { socket = ws; });
  234 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: listing([resource("offline", "离线文件", "file")]) }));
  235 |   await page.route("**/api/v1/files/offline/content", route => { downloads++; return route.fulfill({ body: "unexpected" }); });
  236 |   const files = await openFiles(page);
  237 |   await expect(files.getByText("离线文件", { exact: true })).toBeVisible();
  238 |   await socket.close();
  239 |   await expect(files.getByRole("alert")).toContainText("离线");
  240 |   await files.getByText("离线文件", { exact: true }).dblclick();
  241 |   await files.getByRole("button", { name: "更多操作 离线文件", exact: true }).click();
  242 |   await expect(page.getByRole("menuitem", { name: "下载", exact: true })).toBeDisabled();
  243 |   expect(downloads).toBe(0);
  244 | });
  245 | 
  246 | test("shared socket bursts and snapshot recovery refresh without another socket", async ({ page }) => {
  247 |   let socket!: WebSocketRoute;
  248 |   let sockets = 0;
  249 |   let lists = 0;
  250 |   let name = "初始内容";
  251 |   await page.routeWebSocket("**/api/v1/ws?*", ws => { socket = ws; sockets++; });
  252 |   await page.route("**/api/v1/resources?*", route => { lists++; return route.fulfill({ json: listing([resource("event", name, "file")]) }); });
  253 |   const files = await openFiles(page);
  254 |   await expect(files.getByText("初始内容", { exact: true })).toBeVisible();
  255 |   const baseline = lists;
  256 |   name = "合并刷新";
  257 |   for (let seq = 1; seq <= 5; seq++) socket.send(JSON.stringify({ type: "resources.changed", eventId: `burst-${seq}`, seq, payload: {} }));
  258 |   await expect(files.getByText("合并刷新", { exact: true })).toBeVisible();
  259 |   expect(lists).toBe(baseline + 1);
  260 |   name = "快照恢复";
  261 |   socket.send(JSON.stringify({ type: "workspace.snapshot.required", payload: { currentEventSeq: 10 } }));
  262 |   await expect(files.getByText("快照恢复", { exact: true })).toBeVisible();
  263 |   expect(sockets).toBe(1);
  264 |   name = "重新连接";
  265 |   await socket.close();
  266 |   await expect.poll(() => sockets).toBe(2);
  267 |   await expect(files.getByText("重新连接", { exact: true })).toBeVisible();
  268 | });
  269 | 
  270 | test("late directory responses cannot overwrite navigation or search", async ({ page }) => {
  271 |   let release!: () => void;
  272 |   let blockRoot = false;
  273 |   const gate = new Promise<void>(resolve => { release = resolve; });
  274 |   await page.route("**/api/v1/resources?*", async route => {
  275 |     const params = new URL(route.request().url()).searchParams;
  276 |     if (!params.get("parentId") && blockRoot) await gate;
  277 |     await route.fulfill({ json: params.get("parentId") === "new" ? listing([resource("result", params.get("q") ? "搜索结果" : "新目录文件", "file")], { ancestors: [{ id: "new", name: "新目录" }] }) : listing([resource("new", "新目录")]) });
  278 |   });
  279 |   const files = await openFiles(page);
  280 |   await expect(files.locator('[data-resource-id="new"]')).toBeVisible();
  281 |   blockRoot = true;
  282 |   const requested = page.waitForRequest(req => req.url().includes("/resources?") && !new URL(req.url()).searchParams.get("parentId"));
  283 |   await files.getByRole("button", { name: "刷新", exact: true }).click();
  284 |   await requested;
  285 |   await openFolder(page, "新目录");
  286 |   await files.getByRole("textbox", { name: "搜索文件" }).fill("查询");
  287 |   await expect(files.getByText("搜索结果", { exact: true })).toBeVisible();
  288 |   const lateResponse = page.waitForResponse(response => response.url().includes("/resources?") && !new URL(response.url()).searchParams.get("parentId"));
  289 |   release();
  290 |   await (await lateResponse).finished();
  291 |   await page.evaluate(() => new Promise(requestAnimationFrame));
  292 |   await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("新目录");
  293 |   await expect(files.getByRole("textbox", { name: "搜索文件" })).toHaveValue("查询");
  294 |   await expect(files.getByText("搜索结果", { exact: true })).toBeVisible();
  295 | });
  296 | 
  297 | test("upload completion refreshes current navigation and retains one batch destination", async ({ page }) => {
  298 |   let release!: () => void;
  299 |   const gate = new Promise<void>(resolve => { release = resolve; });
  300 |   const destinations: string[] = [];
  301 |   let started!: () => void;
  302 |   const firstStarted = new Promise<void>(resolve => { started = resolve; });
  303 |   await page.route("**/api/v1/resources?*", route => {
  304 |     const parent = new URL(route.request().url()).searchParams.get("parentId");
  305 |     return route.fulfill({ json: parent === "target" ? listing([resource("child", "目标内容", "file")], { ancestors: [{ id: "target", name: "目标目录" }] }) : listing([resource("target", "目标目录")]) });
  306 |   });
  307 |   await page.route("**/api/v1/uploads", route => {
  308 |     destinations.push(route.request().postDataJSON().parentId);
  309 |     started();
  310 |     return route.fulfill({ json: { id: `upload-${destinations.length}`, chunkSize: 8, totalParts: 1, receivedParts: [], status: "created" } });
  311 |   });
  312 |   await page.route("**/api/v1/uploads/*/parts/*", route => route.fulfill({ json: { status: "received" } }));
  313 |   await page.route("**/api/v1/uploads/*/complete", async route => {
  314 |     await gate;
  315 |     await route.fulfill({ json: { entryId: `entry-${destinations.length}`, resourceId: "blob", name: "已完成" } });
  316 |   });
  317 |   const files = await openFiles(page);
  318 |   await expect(files.getByRole("button", { name: "上传文件", exact: true })).toBeEnabled();
  319 |   await files.getByLabel("选择要上传的文件").setInputFiles([
  320 |     { name: "one.txt", mimeType: "text/plain", buffer: Buffer.from("one") },
  321 |     { name: "two.txt", mimeType: "text/plain", buffer: Buffer.from("two") },
  322 |   ]);
  323 |   await firstStarted;
  324 |   await openFolder(page, "目标目录");
  325 |   await expect(files.getByText("目标内容", { exact: true })).toBeVisible();
  326 |   release();
  327 |   await expect.poll(() => destinations.length).toBe(2);
> 328 |   await expect(page.getByText("two.txt 上传完成", { exact: true })).toBeVisible();
      |                                                                 ^ Error: expect(locator).toBeVisible() failed
  329 |   expect(destinations).toEqual(["", ""]);
  330 |   await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("目标目录");
  331 |   await expect(files.getByText("目标内容", { exact: true })).toBeVisible();
  332 | });
  333 | 
  334 | test("Enter, Shift F10 and Delete share the object commands", async ({ page }) => {
  335 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("parentId") === "keyboard" ? listing([resource("keyfile", "键盘文件", "file")], { ancestors: [{ id: "keyboard", name: "键盘目录" }] }) : listing([resource("keyboard", "键盘目录")]) }));
  336 |   const files = await openFiles(page);
  337 |   const folder = files.getByRole("row", { name: "键盘目录", exact: true });
  338 |   await folder.focus();
  339 |   await folder.press("Enter");
  340 |   const file = files.getByRole("row", { name: "键盘文件", exact: true });
  341 |   await file.focus();
  342 |   await file.press("Shift+F10");
  343 |   await expect(page.getByRole("menuitem", { name: "下载", exact: true })).toBeVisible();
  344 |   await page.keyboard.press("Escape");
  345 |   await expect(file).toBeFocused();
  346 |   await file.press("Delete");
  347 |   await expect(page.getByRole("alertdialog", { name: "确认删除" })).toBeVisible();
  348 |   await page.keyboard.press("Escape");
  349 |   await expect(file).toBeFocused();
  350 | });
  351 | 
  352 | test("information resolves the real resource path rather than visit history", async ({ page }) => {
  353 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("parentId") === "real-parent" ? listing([], { ancestors: [{ id: "real-parent", name: "真实父目录" }] }) : listing([resource("info-file", "简介文件", "file")]) }));
  354 |   await page.route("**/api/v1/resources/info-file", route => route.fulfill({ json: resource("info-file", "简介文件", "file", { parentId: "real-parent" }) }));
  355 |   const files = await openFiles(page);
  356 |   await files.getByRole("button", { name: "更多操作 简介文件", exact: true }).click();
  357 |   await page.getByRole("menuitem", { name: "显示简介", exact: true }).click();
  358 |   const info = page.getByRole("dialog", { name: "显示简介", exact: true });
  359 |   await expect(info).toContainText("共享根目录 / 真实父目录 / 简介文件");
  360 | });
  361 | 
  362 | test("live gateway create rename and remote removal honor the file contract", async ({ page }) => {
  363 |   const files = await openFiles(page);
  364 |   const token = await page.evaluate(() => localStorage.getItem("linkos.access_token"));
  365 |   const headers = { authorization: `Bearer ${token}` };
  366 |   const rootName = `000-f3-${crypto.randomUUID()}`;
  367 |   const response = await page.request.post("/api/v1/resources", { headers, data: { type: "folder", name: rootName, parentId: "" } });
  368 |   expect(response.status()).toBe(201);
  369 |   const root = await response.json();
  370 |   try {
  371 |     const contract = await (await page.request.get(`/api/v1/resources?scope=files&parentId=${root.id}`, { headers })).json();
  372 |     expect(contract, "live gateway must expose the F3 directory contract").toMatchObject({ ancestors: [{ id: root.id, name: rootName }], canRead: true, canWrite: true, canCreateChild: true, total: 0 });
  373 |     await files.getByRole("textbox", { name: "搜索文件" }).fill(rootName);
  374 |     await openFolder(page, rootName);
  375 |     await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText(rootName);
  376 |     await files.getByRole("button", { name: "新建文件夹", exact: true }).click();
  377 |     const form = page.getByRole("dialog", { name: "新建文件夹", exact: true });
  378 |     await form.getByRole("textbox", { name: "名称", exact: true }).fill("子目录");
  379 |     await form.getByRole("button", { name: "创建", exact: true }).click();
  380 |     const child = files.getByRole("row", { name: "子目录", exact: true });
  381 |     await expect(child).toBeVisible();
  382 |     await child.focus();
  383 |     await child.press("F2");
  384 |     const rename = page.getByRole("dialog", { name: "重命名", exact: true });
  385 |     await rename.getByRole("textbox", { name: "名称", exact: true }).fill("已重命名");
  386 |     await rename.getByRole("button", { name: "重命名", exact: true }).click();
  387 |     await expect(files.getByRole("row", { name: "已重命名", exact: true })).toBeVisible();
  388 |     const childId = await files.getByRole("row", { name: "已重命名", exact: true }).getAttribute("data-resource-id");
  389 |     await openFolder(page, "已重命名");
  390 |     await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("已重命名");
  391 |     const removed = await page.request.delete(`/api/v1/resources/${childId}?recursive=true`, { headers });
  392 |     expect(removed.ok()).toBe(true);
  393 |     await expect(files.getByRole("status")).toContainText("已返回");
  394 |     await expect(files.getByRole("navigation", { name: "文件路径" })).not.toContainText("已重命名");
  395 |     await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText(rootName);
  396 |   } finally {
  397 |     await page.request.delete(`/api/v1/resources/${root.id}?recursive=true`, { headers });
  398 |   }
  399 | });
  400 | 
  401 | test("mobile objects have reachable menus, single tap folders, and no 390px overflow", async ({ page }) => {
  402 |   await page.setViewportSize({ width: 390, height: 844 });
  403 |   await page.route("**/api/v1/resources?*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("parentId") === "mobile" ? listing([], { ancestors: [{ id: "mobile", name: "手机目录" }] }) : listing([resource("mobile", "手机目录")]) }));
  404 |   const files = await openFiles(page);
  405 |   await expect(files.getByRole("button", { name: "更多操作 手机目录", exact: true })).toBeVisible();
  406 |   await openFolder(page, "手机目录");
  407 |   await expect(files.getByRole("navigation", { name: "文件路径" })).toContainText("手机目录");
  408 |   expect(await files.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  409 |   await expect(files.getByRole("button", { name: "本机历史", exact: true })).toBeVisible();
  410 | });
  411 | 
```