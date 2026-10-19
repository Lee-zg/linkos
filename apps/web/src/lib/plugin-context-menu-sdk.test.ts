import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../../../../packages/plugin-sdk/src/index.ts", import.meta.url),
  "utf8",
);
const javascript = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;

async function fixture() {
  const document = new EventTarget() as EventTarget & {
    activeElement: Element | null;
    documentElement: Element;
  };
  class Element extends EventTarget {
    isConnected = true;
    focusable = true;
    parentElement: Element | null = null;
    closest() {
      for (let node: Element | null = this; node; node = node.parentElement)
        if (node.focusable) return node;
      return null;
    }
    constructor(public name: string) {
      super();
    }
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        right: 100,
        bottom: 30,
        width: 100,
        height: 30,
      };
    }
    focus() {
      if (this.focusable) document.activeElement = this;
    }
    contains(other: Element) {
      for (let node: Element | null = other; node; node = node.parentElement)
        if (node === this) return true;
      return false;
    }
  }
  document.documentElement = new Element("html");
  document.activeElement = document.documentElement;
  const window = Object.assign(new EventTarget(), {
    parent: { postMessage() {} },
    innerWidth: 500,
    innerHeight: 400,
  });
  const calls: any[] = [];
  const port = {
    onmessage: null as ((event: { data: any }) => void) | null,
    start() {},
    close() {},
    postMessage(request: any) {
      calls.push(request);
      if (request.type === "request")
        queueMicrotask(() =>
          port.onmessage?.({
            data: {
              type: "response",
              id: request.id,
              result:
                request.method === "ui.contextMenu.open"
                  ? { token: `menu-${request.params.seq}` }
                  : null,
            },
          }),
        );
    },
  };
  const exports: any = {};
  runInNewContext(javascript, {
    exports,
    window,
    document,
    HTMLElement: Element,
    Element,
    Node: Element,
    TextEncoder,
    crypto,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    Event,
    Map,
    Set,
  });
  const connected = exports.connectPlugin({
    id: "fixture.menu",
    version: "1.0.0",
  });
  function message(data: any, ports: any[] = []) {
    const event = Object.assign(new Event("message"), {
      data,
      source: window.parent,
      origin: "https://host.test",
      ports,
    });
    window.dispatchEvent(event);
  }
  message({
    type: "linkos.host.init",
    protocol: "1.0",
    pluginId: "fixture.menu",
    version: "1.0.0",
    nonce: "nonce",
  });
  message({ type: "linkos.host.connect", protocol: "1.0", nonce: "nonce" }, [
    port,
  ]);
  const client = await connected;
  function gesture(
    target: Element,
    type = "contextmenu",
    properties: Record<string, unknown> = {},
  ) {
    const event = new Event(type, { cancelable: true });
    if (properties.preCanceled) event.preventDefault();
    const path: EventTarget[] = [];
    for (let node: Element | null = target; node; node = node.parentElement)
      path.push(node);
    path.push(document, window);
    Object.defineProperties(event, {
      target: { value: target },
      composedPath: { value: () => path },
      clientX: { value: 0 },
      clientY: { value: 0 },
      ...Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, { value }]),
      ),
    });
    document.dispatchEvent(event);
    return event;
  }
  return { client, calls, port, Element, document, window, gesture };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("legacy guard cancels native menus without consuming composing or editing keys", () => {
  const guardSource = readFileSync(
    new URL(
      "../../../../services/gateway/plugin_context_menu.go",
      import.meta.url,
    ),
    "utf8",
  );
  const script = guardSource.match(
    /const pluginContextMenuGuard = `<script[^>]*>([^`]+)<\/script>`/,
  )?.[1];
  assert.ok(script);
  const document = new EventTarget();
  runInNewContext(script, { document });
  const composing = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "F10",
    shiftKey: true,
    isComposing: true,
  });
  document.dispatchEvent(composing);
  assert.equal(composing.defaultPrevented, false);
  const menu = new Event("contextmenu", { cancelable: true });
  document.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true);
  for (const key of ["c", "v", "Process"]) {
    const event = Object.assign(new Event("keydown", { cancelable: true }), {
      key,
      ctrlKey: true,
    });
    document.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
});

test("SDK offers explicit scoped menu registration and keeps unregistered input silent", async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.client.ui.registerContextMenu, "function");
    const input = new f.Element("input");
    assert.equal(f.gesture(input).defaultPrevented, true);
    await flush();
    assert.equal(
      f.calls.filter((call) => call.method === "ui.contextMenu.open").length,
      0,
    );
  } finally {
    f.client.dispose();
  }
});

test("SDK waits for commands, keeps zero coordinates and does not skip guard-cancelled gestures", async () => {
  const f = await fixture();
  try {
    f.client.ui.registerCommand({ id: "refresh", title: "Refresh", run() {} });
    assert.equal(typeof f.client.ui.registerContextMenu, "function");
    const target = new f.Element("list");
    f.client.ui.registerContextMenu(target, () => [
      { id: "main", items: [{ commandId: "refresh" }] },
    ]);
    // A gateway guard has already cancelled the default action before SDK delivery.
    assert.equal(
      f.gesture(target, "contextmenu", { preCanceled: true }).defaultPrevented,
      true,
    );
    await flush();
    const open = f.calls.find((call) => call.method === "ui.contextMenu.open");
    assert.ok(open);
    assert.equal(open.params.anchor.x, 0);
    assert.equal(open.params.anchor.y, 0);
  } finally {
    f.client.dispose();
  }
});

test("nearest empty provider stops parent fallback and disposal cancels its pending menu", async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.client.ui.registerContextMenu, "function");
    f.client.ui.registerCommand({ id: "refresh", title: "Refresh", run() {} });
    const root = new f.Element("root"),
      child = new f.Element("child");
    child.parentElement = root;
    f.client.ui.registerContextMenu(root, () => [
      { id: "main", items: [{ commandId: "refresh" }] },
    ]);
    const remove = f.client.ui.registerContextMenu(child, () => []);
    f.gesture(child);
    await flush();
    assert.equal(
      f.calls.filter((call) => call.method === "ui.contextMenu.open").length,
      0,
    );
    remove();
    const dispose = f.client.ui.registerContextMenu(child, () => [
      { id: "main", items: [{ commandId: "refresh" }] },
    ]);
    f.gesture(child);
    dispose();
    await flush();
    assert.equal(
      f.calls.filter((call) => call.method === "ui.contextMenu.open").length,
      0,
    );
  } finally {
    f.client.dispose();
  }
});

test("SDK menu keyboard handling leaves text editing shortcuts alone", async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.client.ui.registerContextMenu, "function");
    const target = new f.Element("textarea");
    assert.equal(
      f.gesture(target, "keydown", { key: "F10", shiftKey: true })
        .defaultPrevented,
      true,
    );
    assert.equal(
      f.gesture(target, "keydown", { key: "c", ctrlKey: true })
        .defaultPrevented,
      false,
    );
    assert.equal(
      f.gesture(target, "keydown", { key: "v", ctrlKey: true })
        .defaultPrevented,
      false,
    );
    assert.equal(
      f.gesture(target, "keydown", { key: "Process", isComposing: true })
        .defaultPrevented,
      false,
    );
    assert.equal(
      f.gesture(target, "keydown", {
        key: "F10",
        shiftKey: true,
        isComposing: true,
      }).defaultPrevented,
      false,
    );
  } finally {
    f.client.dispose();
  }
});

test("SDK Escape cancels a pending menu without consuming the application key", async () => {
  const f = await fixture();
  try {
    const target = new f.Element("list");
    f.client.ui.registerCommand({ id: "refresh", title: "Refresh", run() {} });
    f.client.ui.registerContextMenu(target, () => [
      { id: "main", items: [{ commandId: "refresh" }] },
    ]);
    f.gesture(target);
    const key = f.gesture(target, "keydown", { key: "Escape" });
    await flush();
    assert.equal(key.defaultPrevented, false);
    assert.equal(
      f.calls.filter((call) => call.method === "ui.contextMenu.open").length,
      0,
    );
  } finally {
    f.client.dispose();
  }
});

test("SDK ignores old lifecycle and command messages after a new gesture", async () => {
  const f = await fixture();
  try {
    const first = new f.Element("first"),
      second = new f.Element("second");
    let runs = 0;
    f.client.ui.registerCommand({
      id: "refresh",
      title: "Refresh",
      run() {
        runs++;
      },
    });
    for (const target of [first, second])
      f.client.ui.registerContextMenu(target, () => [
        { id: "main", items: [{ commandId: "refresh" }] },
      ]);
    f.gesture(first);
    await flush();
    const old = f.calls.find((call) => call.method === "ui.contextMenu.open")
      .params.seq;
    f.gesture(second);
    await flush();
    const latest = f.calls
      .filter((call) => call.method === "ui.contextMenu.open")
      .at(-1).params.seq;
    f.port.onmessage?.({
      data: {
        type: "context-menu.closed",
        seq: old,
        token: `menu-${old}`,
        restoreFocus: true,
      },
    });
    f.port.onmessage?.({
      data: {
        type: "command",
        id: "refresh",
        contextMenu: { seq: old, token: `menu-${old}` },
      },
    });
    assert.equal(runs, 0);
    assert.notEqual(f.document.activeElement, first);
    f.port.onmessage?.({
      data: {
        type: "command",
        id: "refresh",
        contextMenu: { seq: latest, token: `menu-${latest}` },
      },
    });
    assert.equal(runs, 1);
    assert.equal(f.document.activeElement, second);
  } finally {
    f.client.dispose();
  }
});

test("SDK keeps the getter target but restores its focusable ancestor", async () => {
  const f = await fixture();
  try {
    const button = new f.Element("button"),
      span = new f.Element("span");
    span.focusable = false;
    span.parentElement = button;
    let businessTarget: unknown;
    f.client.ui.registerCommand({ id: "refresh", title: "Refresh", run() {} });
    f.client.ui.registerContextMenu(button, (trigger: any) => {
      businessTarget = trigger.target;
      return [{ id: "main", items: [{ commandId: "refresh" }] }];
    });
    f.gesture(span);
    await flush();
    const seq = f.calls.find((call) => call.method === "ui.contextMenu.open")
      .params.seq;
    f.port.onmessage?.({
      data: {
        type: "context-menu.closed",
        seq,
        token: `menu-${seq}`,
        restoreFocus: true,
      },
    });
    assert.equal(businessTarget, span);
    assert.equal(f.document.activeElement, button);
  } finally {
    f.client.dispose();
  }
});

test("SDK host-menu blur preserves the request but returning to iframe invalidates it", async () => {
  const f = await fixture();
  try {
    const target = new f.Element("list");
    f.client.ui.registerCommand({ id: "refresh", title: "Refresh", run() {} });
    f.client.ui.registerContextMenu(target, () => [
      { id: "main", items: [{ commandId: "refresh" }] },
    ]);
    f.gesture(target);
    await flush();
    const seq = f.calls.find((call) => call.method === "ui.contextMenu.open")
      .params.seq;
    f.window.dispatchEvent(new Event("blur"));
    assert.equal(
      f.calls.filter((call) => call.method === "ui.contextMenu.cancel").length,
      0,
    );
    f.window.dispatchEvent(new Event("focus"));
    assert.equal(
      f.calls.filter((call) => call.method === "ui.contextMenu.cancel").at(-1)
        .params.seq,
      seq,
    );
    f.port.onmessage?.({
      data: {
        type: "context-menu.closed",
        seq,
        token: `menu-${seq}`,
        restoreFocus: true,
      },
    });
    assert.notEqual(f.document.activeElement, target);
  } finally {
    f.client.dispose();
  }
});
