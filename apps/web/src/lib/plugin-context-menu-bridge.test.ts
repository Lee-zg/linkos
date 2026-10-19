import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as menuHelpers from "./plugin-context-menu.js";
import * as policy from "./plugin-policy.js";
import {
  ContextMenuController,
  createMenuScope,
} from "../os/context-menu-controller.js";

// Execute the actual component/effects, not a copied receive() implementation.
// Only React/browser/transport dependencies are faked; parsing, tickets and the
// global ownership/epoch controller are production code.
const filename = new URL("../apps/PluginFrame.tsx", import.meta.url);
const javascript = ts.transpileModule(readFileSync(filename, "utf8"), {
  fileName: filename.pathname,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const menu = (seq: number, commandId = "refresh") => ({
  seq,
  registrationId: "list",
  anchor: { x: 0, y: 0 },
  groups: [{ id: "main", items: [{ commandId }] }],
});
const environment = () => ({
  menus: new ContextMenuController(),
  document: { activeElement: null as unknown },
});
type RPC = {
  method: string;
  params: any;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
type Command = { id: string; title: string; run: () => Promise<void> };

async function fixture(
  t: TestContext,
  options: { env?: ReturnType<typeof environment>; stageId?: string } = {},
) {
  const env = options.env ?? environment();
  const plugin = {
    id: "fixture.menu",
    name: "Fixture",
    version: "1.0.0",
    revision: 1,
    permissions: ["ui.command", "ui.notify", "event.subscribe:workspace.*"],
    manifest: {
      contributes: {
        commands: [
          "refresh",
          ...Array.from({ length: 33 }, (_, i) => `cmd-${i}`),
        ],
      },
    },
  };
  const element = {
    isConnected: true,
    clientWidth: 500,
    clientHeight: 300,
    offsetWidth: 500,
    offsetHeight: 300,
    clientLeft: 2,
    clientTop: 2,
    getBoundingClientRect: () => ({
      left: 100,
      top: 80,
      width: 1000,
      height: 600,
    }),
    contentWindow: { postMessage() {} },
  };
  const boundary = { isConnected: true } as HTMLElement;
  const scope = createMenuScope({
    kind: "app",
    appId: plugin.id,
    windowId: "window",
  });
  const unregisterScope = env.menus.registerScope(scope, boundary);
  const refs: { current: any }[] = [];
  const effects: (() => (() => void) | undefined)[] = [];
  const commands = new Map<string, Command>();
  const rpc: RPC[] = [];
  const notifications: unknown[][] = [];
  const messages: any[] = [];
  let failRegistration = false;
  let now = 0;
  let timerId = 0;
  const timers = new Map<
    number,
    { callback: () => void; at: number; interval: number }
  >();
  const schedule = (callback: () => void, delay: number, interval = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, at: now + delay, interval });
    return id;
  };
  const clearTimer = (id: number) => {
    timers.delete(id);
  };
  const window = Object.assign(new EventTarget(), {
    setTimeout: schedule,
    clearTimeout: clearTimer,
    setInterval: (callback: () => void, delay: number) =>
      schedule(callback, delay, delay),
    clearInterval: clearTimer,
  });
  class Port {
    onmessage:
      ((event: { data: unknown; target: unknown }) => Promise<void>) | null =
      null;
    closed = false;
    start() {}
    close() {
      this.closed = true;
    }
    postMessage(value: unknown) {
      assert.equal(
        this.closed,
        false,
        "host must not post to a closed connection",
      );
      messages.push(structuredClone(value));
    }
  }
  const channels: { port1: Port; port2: Port }[] = [];
  const dependencies: Record<string, unknown> = {
    react: {
      useRef: (current: unknown) => {
        const ref = { current };
        refs.push(ref);
        return ref;
      },
      useState: (value: unknown) => [value, () => {}],
      useEffect: (effect: () => (() => void) | undefined) => {
        effects.push(effect);
      },
    },
    "react/jsx-runtime": {
      jsx: (type: unknown, props: unknown) => ({ type, props }),
      jsxs: (type: unknown, props: unknown) => ({ type, props }),
    },
    "../lib/api": {
      apiURL: (url: string) => url,
      getPluginTicket: async () => ({ nonce: "nonce", src: "/plugin" }),
      pluginRPC: (
        _plugin: unknown,
        method: string,
        params: unknown,
        signal?: AbortSignal,
      ) =>
        new Promise((resolve, reject) => {
          rpc.push({ method, params, signal, resolve, reject });
        }),
    },
    "../lib/plugin-frame-policy": { enforcePluginFramePolicy() {} },
    "../lib/plugin-policy": policy,
    "../lib/plugin-context-menu": menuHelpers,
    "../lib/workspace": {
      useWorkspace: () => ({ connected: true, lastEvent: null }),
    },
    "../os/ContextMenu": { useContextMenu: () => ({ controller: env.menus }) },
    "../os/ContextMenuScope": { useContextMenuScope: () => scope },
    "../os/Toaster": {
      useToast:
        () =>
        (...args: unknown[]) =>
          notifications.push(args),
    },
    "../os/app-registry": {
      useAppRegistry: () => ({
        registerCommand: (_pluginId: string, command: Command) => {
          if (failRegistration) throw new Error("command registration failed");
          commands.set(command.id, command);
          return () => {
            if (commands.get(command.id) === command)
              commands.delete(command.id);
          };
        },
      }),
    },
  };
  const exports: any = {};
  runInNewContext(
    javascript,
    {
      exports,
      require: (name: string) => {
        assert.ok(name in dependencies, `unexpected host dependency: ${name}`);
        return dependencies[name];
      },
      window,
      document: env.document,
      fetch: async () => ({ ok: true }),
      MessageChannel: class {
        port1 = new Port();
        port2 = new Port();
        constructor() {
          channels.push(this);
        }
      },
      AbortController,
      Error,
      TextEncoder,
      crypto,
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      setTimeout: schedule,
      clearTimeout: clearTimer,
    },
    { filename: filename.pathname },
  );
  exports.PluginFrame({ plugin, stageId: options.stageId });
  const cleanups = effects.map((effect) => effect());
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cleanups.forEach((cleanup) => cleanup?.());
    unregisterScope();
  };
  t.after(dispose);
  await flush(); // Ticket issuance and HEAD verification precede handshake.
  refs[0].current = element;
  function handshake(source = element.contentWindow, origin = "null") {
    window.dispatchEvent(
      Object.assign(new Event("message"), {
        source,
        origin,
        data: {
          type: "linkos.plugin.ready",
          nonce: "nonce",
          pluginId: plugin.id,
          version: plugin.version,
          protocol: "1.0",
        },
      }),
    );
  }
  handshake({ postMessage() {} });
  handshake(element.contentWindow, "https://untrusted.test");
  assert.equal(channels.length, 0, "handshake checks source and opaque origin");
  handshake();
  assert.equal(channels.length, 1);
  const port = channels[0].port1;
  assert.ok(port.onmessage);
  let id = 0;
  const send = (
    method: string,
    params: unknown = {},
    target: unknown = port,
  ) => {
    const requestId = String(++id);
    const done = port.onmessage!({
      data: structuredClone({ type: "request", id: requestId, method, params }),
      target,
    });
    return {
      done,
      response: () =>
        messages.find(
          (message) => message.type === "response" && message.id === requestId,
        ),
    };
  };
  const takeRPC = (method = "auth.check") => {
    const call = rpc.shift();
    assert.ok(call, `expected pending ${method}`);
    assert.equal(call.method, method);
    return call;
  };
  const register = async (id = "refresh", title = "Registered title") => {
    const request = send("ui.registerCommand", { id, title });
    takeRPC().resolve(true);
    await request.done;
    assert.equal(request.response()?.error, undefined);
    assert.ok(commands.has(id));
  };
  const open = async (seq: number) => {
    env.document.activeElement = element;
    const request = send("ui.contextMenu.open", menu(seq));
    takeRPC().resolve(true);
    await request.done;
    assert.ok(
      request.response()?.result.token,
      "authorized open must return a token",
    );
    return env.menus.getSnapshot()!;
  };
  return {
    ...env,
    plugin,
    element,
    scope,
    boundary,
    port,
    refs,
    commands,
    rpc,
    messages,
    notifications,
    dispose,
    send,
    takeRPC,
    register,
    open,
    setRegistrationFailure(value: boolean) {
      failRegistration = value;
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        if (timer.interval) timer.at = now + timer.interval;
        else timers.delete(id);
        timer.callback();
      }
    },
  };
}

for (const kind of ["older seq", "duplicate seq", "invalid shape"]) {
  test(`host preserves a visible menu after ${kind}`, async (t) => {
    const f = await fixture(t);
    await f.register();
    const current = await f.open(2);
    const epoch = f.menus.epoch;
    const request = f.send(
      "ui.contextMenu.open",
      kind === "invalid shape"
        ? { ...menu(3), groups: "invalid" }
        : menu(kind === "older seq" ? 1 : 2),
    );
    await request.done;
    assert.equal(
      f.menus.getSnapshot()?.token,
      current.token,
      "rejected open must not dismiss the current menu",
    );
    assert.equal(f.menus.epoch, epoch);
    assert.equal(f.rpc.length, 0);
    assert.equal(
      f.messages.filter((message) => message.type === "context-menu.closed")
        .length,
      0,
    );
    if (kind === "invalid shape")
      assert.match(request.response().error, /无效/);
    else assert.equal(request.response().result.token, null);
  });
}

test("host preserves a pending newer open after an older request", async (t) => {
  const f = await fixture(t);
  await f.register();
  f.document.activeElement = f.element;
  const newer = f.send("ui.contextMenu.open", menu(2));
  const auth = f.takeRPC();
  const epoch = f.menus.epoch;
  await f.send("ui.contextMenu.open", menu(1)).done;
  assert.equal(f.menus.epoch, epoch);
  auth.resolve(true);
  await newer.done;
  assert.ok(
    newer.response().result.token,
    "stale request must not invalidate the newer ticket",
  );
});

test("host admission dismisses another frame's visible menu before authorization", async (t) => {
  const env = environment();
  const a = await fixture(t, { env });
  const b = await fixture(t, { env });
  await a.register();
  await b.register();
  await a.open(1);
  const epoch = env.menus.epoch;
  env.document.activeElement = b.element;
  const opening = b.send("ui.contextMenu.open", menu(1));
  const auth = b.takeRPC();
  assert.equal(
    env.menus.getSnapshot(),
    null,
    "valid admission must dismiss globally before awaiting auth",
  );
  assert.ok(env.menus.epoch > epoch);
  const closed = a.messages.find(
    (message) => message.type === "context-menu.closed",
  );
  assert.equal(closed?.restoreFocus, false);
  auth.resolve(true);
  await opening.done;
  assert.ok(opening.response().result.token);
});

test("host rejects A's delayed click auth when B with no menu token starts opening", async (t) => {
  const env = environment();
  const a = await fixture(t, { env });
  const b = await fixture(t, { env });
  await a.register();
  await b.register();
  const current = await a.open(1);
  env.menus.activate(current.token, 0);
  const clickAuth = a.takeRPC();
  assert.equal(env.menus.getSnapshot(), null);
  env.document.activeElement = b.element;
  const opening = b.send("ui.contextMenu.open", menu(1));
  const openAuth = b.takeRPC();
  clickAuth.resolve(true); // B's auth is still unresolved: no visible replacement yet.
  await flush();
  assert.equal(
    a.messages.filter((message) => message.type === "command").length,
    0,
    "a newer admitted gesture must prevent A's command from stealing focus",
  );
  assert.equal(
    a.messages.find((message) => message.type === "context-menu.closed")
      ?.restoreFocus,
    false,
  );
  openAuth.resolve(true);
  await opening.done;
  assert.ok(opening.response().result.token);
});

for (const reason of [
  "focus",
  "scope",
  "owner",
  "detached frame",
  "missing frame",
  "permission",
]) {
  test(`host rejected ${reason} admission leaves menu and sequence unchanged`, async (t) => {
    const f = await fixture(t);
    await f.register();
    const current = await f.open(1);
    const epoch = f.menus.epoch;
    const owner = f.scope.owner;
    if (reason === "focus") f.document.activeElement = null;
    if (reason === "scope") f.scope.active = false;
    if (reason === "owner")
      Object.assign(f.scope, { owner: { kind: "desktop" } });
    if (reason === "detached frame") f.element.isConnected = false;
    if (reason === "missing frame") f.refs[0].current = null;
    if (reason === "permission") f.plugin.permissions = [];
    const rejected = f.send("ui.contextMenu.open", menu(2));
    await rejected.done;
    assert.equal(rejected.response().result.token, null);
    assert.equal(f.menus.getSnapshot()?.token, current.token);
    assert.equal(f.menus.epoch, epoch);
    assert.equal(f.rpc.length, 0);
    f.document.activeElement = f.element;
    f.scope.active = true;
    Object.assign(f.scope, { owner });
    f.element.isConnected = true;
    f.refs[0].current = f.element;
    f.plugin.permissions = ["ui.command"];
    await f.open(2); // A rejected admission must not consume this sequence.
  });
}

test("host safely replaces its own ticket without invalidating the new open", async (t) => {
  const f = await fixture(t);
  await f.register();
  const first = await f.open(1);
  const next = await f.open(2);
  assert.notEqual(first.token, next.token);
  const closed = f.messages.find(
    (message) => message.type === "context-menu.closed",
  );
  assert.equal(closed?.seq, 1);
  assert.equal(closed?.restoreFocus, false);
  f.menus.activate(next.token, 0);
  f.takeRPC().resolve(true);
  await flush();
  assert.equal(
    f.messages.find((message) => message.type === "command")?.contextMenu.seq,
    2,
  );
});

for (const visible of [false, true]) {
  test(`host cancel bypasses all eight occupied RPC slots (${visible ? "visible" : "pending"} menu)`, async (t) => {
    const f = await fixture(t);
    await f.register();
    f.document.activeElement = f.element;
    if (visible) await f.open(1);
    const opening = visible ? null : f.send("ui.contextMenu.open", menu(1));
    const openAuth = opening ? f.takeRPC() : null;
    const busy = Array.from({ length: visible ? 8 : 7 }, () => {
      const request = f.send("fixture.business");
      return { request, rpc: f.takeRPC("fixture.business") };
    });
    const overflow = f.send("ui.contextMenu.open", menu(2));
    await overflow.done;
    assert.match(overflow.response().error, /频繁/);
    const cancel = f.send("ui.contextMenu.cancel", { seq: 1 });
    await cancel.done;
    assert.equal(cancel.response().result, null);
    assert.equal(f.menus.getSnapshot(), null);
    assert.equal(
      f.rpc.length,
      0,
      "cancel must not require authorization or a business slot",
    );
    openAuth?.resolve(true);
    if (opening) {
      await opening.done;
      assert.equal(opening.response().result.token, null);
    }
    for (const { request, rpc } of busy) {
      rpc.resolve(null);
      await request.done;
    }
    await f.open(2); // Rejected overflow did not consume the sequence either.
  });
}

test("host ignores old and foreign-port cancels without dismissing the current menu", async (t) => {
  const f = await fixture(t);
  await f.register();
  const current = await f.open(2);
  const epoch = f.menus.epoch;
  await f.send("ui.contextMenu.cancel", { seq: 1 }).done;
  const foreign = f.send("ui.contextMenu.cancel", { seq: 2 }, {});
  await foreign.done;
  assert.equal(foreign.response(), undefined);
  assert.equal(f.menus.getSnapshot()?.token, current.token);
  assert.equal(f.menus.epoch, epoch);
  const other = await fixture(t, { env: f });
  await other.send("ui.contextMenu.cancel", { seq: 2 }).done;
  assert.equal(f.menus.getSnapshot()?.token, current.token);
});

test("host retains the newer menu when open authorization resolves out of order", async (t) => {
  const f = await fixture(t);
  await f.register();
  f.document.activeElement = f.element;
  const older = f.send("ui.contextMenu.open", menu(1));
  const oldAuth = f.takeRPC();
  const newer = f.send("ui.contextMenu.open", menu(2));
  f.takeRPC().resolve(true);
  await newer.done;
  const current = f.menus.getSnapshot()!;
  assert.ok(current);
  oldAuth.resolve(true);
  await older.done;
  assert.equal(older.response().result.token, null);
  assert.equal(f.menus.getSnapshot()?.token, current.token);
});

for (const fails of [false, true]) {
  test(`host keeps the latest command registration when older auth ${fails ? "rejects" : "succeeds"}`, async (t) => {
    const f = await fixture(t);
    const old = f.send("ui.registerCommand", { id: "refresh", title: "Old" });
    const oldAuth = f.takeRPC();
    const latest = f.send("ui.registerCommand", {
      id: "refresh",
      title: "New",
    });
    const newAuth = f.takeRPC();
    if (fails) {
      oldAuth.reject(new Error("old authorization failed"));
      await old.done; // Old cleanup must not delete the newer reservation.
    }
    newAuth.resolve(true);
    await latest.done;
    if (!fails) {
      oldAuth.resolve(true);
      await old.done;
    }
    assert.equal(f.commands.get("refresh")?.title, "New");
    const current = await f.open(1);
    assert.equal(current.groups[0].items[0].label, "New");
  });
}

test("host unregister prevents a late command registration from resurrecting", async (t) => {
  const f = await fixture(t);
  const registering = f.send("ui.registerCommand", {
    id: "refresh",
    title: "Old",
  });
  const auth = f.takeRPC();
  await f.send("ui.unregisterCommand", { id: "refresh" }).done;
  auth.resolve(true);
  await registering.done;
  assert.equal(f.commands.size, 0);
  f.document.activeElement = f.element;
  const opening = f.send("ui.contextMenu.open", menu(1));
  await opening.done;
  assert.match(opening.response().error, /无效/);
  assert.equal(f.rpc.length, 0);
});

for (const failure of [
  "denied auth",
  "rejected auth",
  "registry exception",
  "timeout",
]) {
  test(`host frees a failed registration slot after ${failure}`, async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 31; i++) {
      await f.register(`cmd-${i}`);
      f.advance(1001); // Stay within the unchanged per-second business limit.
    }
    const failing = f.send("ui.registerCommand", { id: "cmd-31" });
    const auth = f.takeRPC();
    if (failure === "registry exception") f.setRegistrationFailure(true);
    if (failure === "timeout") f.advance(5001);
    if (failure === "rejected auth") auth.reject(new Error("auth unavailable"));
    else auth.resolve(failure !== "denied auth");
    await failing.done;
    f.setRegistrationFailure(false);
    assert.equal(f.commands.size, 31);
    const replacement = f.send("ui.registerCommand", { id: "cmd-32" });
    assert.equal(
      replacement.response()?.error,
      undefined,
      "failed reservation must not leak one of the 32 command slots",
    );
    f.takeRPC().resolve(true);
    await replacement.done;
    assert.equal(f.commands.size, 32);
    const overflow = f.send("ui.registerCommand", { id: "refresh" });
    await overflow.done;
    assert.match(overflow.response().error, /数量超过限制/);
    assert.equal(f.rpc.length, 0);
  });
}

for (const phase of ["open", "click", "register", "notify", "subscribe"]) {
  test(`host ignores late ${phase} auth after unmount`, async (t) => {
    const f = await fixture(t);
    await f.register();
    f.document.activeElement = f.element;
    let request: ReturnType<typeof f.send> | undefined;
    if (phase === "click") {
      const current = await f.open(1);
      f.menus.activate(current.token, 0);
    } else {
      const calls = {
        open: ["ui.contextMenu.open", menu(1)],
        register: ["ui.registerCommand", { id: "refresh" }],
        notify: ["ui.notify", { title: "late" }],
        subscribe: ["events.subscribe", { type: "workspace.*" }],
      } as const;
      const [method, params] = calls[phase as keyof typeof calls];
      request = f.send(method, params);
    }
    const auth = f.takeRPC();
    f.dispose();
    assert.equal(auth.signal?.aborted, true);
    const messageCount = f.messages.length;
    auth.resolve(true); // Transport may complete despite the abort signal.
    await request?.done;
    await flush();
    assert.equal(f.messages.length, messageCount);
    assert.equal(f.menus.getSnapshot(), null);
    assert.equal(f.commands.size, 0);
    assert.equal(f.notifications.length, 0);
    assert.equal(
      f.refs[3].current.size,
      0,
      "late auth cannot repopulate subscriptions",
    );
  });
}

test("host checks connection identity after auth even without effect cleanup", async (t) => {
  const f = await fixture(t);
  const request = f.send("ui.notify", { title: "late" });
  const auth = f.takeRPC();
  f.refs[1].current = null;
  auth.resolve(true);
  await request.done;
  assert.equal(request.response(), undefined);
  assert.equal(f.notifications.length, 0);
});

for (const invalidation of [
  "denied",
  "timeout",
  "scope",
  "frame",
  "focus",
  "connection",
  "unregister",
  "dismiss",
]) {
  test(`host rechecks ${invalidation} after menu authorization`, async (t) => {
    const f = await fixture(t);
    await f.register();
    f.document.activeElement = f.element;
    const request = f.send("ui.contextMenu.open", menu(1));
    const auth = f.takeRPC();
    if (invalidation === "timeout") f.advance(5001);
    if (invalidation === "scope") f.scope.active = false;
    if (invalidation === "frame") f.refs[0].current = { ...f.element };
    if (invalidation === "focus") f.document.activeElement = null;
    if (invalidation === "connection") f.refs[1].current = null;
    if (invalidation === "unregister")
      await f.send("ui.unregisterCommand", { id: "refresh" }).done;
    if (invalidation === "dismiss") f.menus.dismiss();
    auth.resolve(invalidation !== "denied");
    await request.done;
    assert.equal(f.menus.getSnapshot(), null);
    if (invalidation === "connection")
      assert.equal(request.response(), undefined);
    else assert.equal(request.response().result.token, null);
  });
}

test("host uses registered titles and scaled anchors, not plugin-supplied labels", async (t) => {
  const f = await fixture(t);
  await f.register("refresh", "Title".repeat(25));
  f.document.activeElement = f.element;
  const request = f.send("ui.contextMenu.open", {
    ...menu(1),
    groups: [
      {
        id: "main",
        items: [{ commandId: "refresh", label: "Untrusted title" }],
      },
    ],
  });
  f.takeRPC().resolve(true);
  await request.done;
  const current = f.menus.getSnapshot()!;
  assert.equal(current.groups[0].items[0].label, "Title".repeat(20));
  assert.deepEqual(current.anchor, { x: 104, y: 84 });
  assert.equal(current.target, null);
  assert.equal(current.groups[0].items[0].restoreFocus, false);
});

test("host rejects staged and foreign-source menu requests before global admission", async (t) => {
  const f = await fixture(t);
  await f.register();
  const current = await f.open(1);
  const epoch = f.menus.epoch;
  const foreign = f.send("ui.contextMenu.open", menu(2), {});
  await foreign.done;
  assert.equal(foreign.response(), undefined);
  const staged = await fixture(t, { env: f, stageId: "candidate" });
  for (const [method, params] of [
    ["ui.contextMenu.open", menu(1)],
    ["ui.contextMenu.cancel", { seq: 1 }],
  ] as const) {
    const request = staged.send(method, params);
    await request.done;
    assert.ok(request.response().error);
  }
  assert.equal(f.menus.getSnapshot()?.token, current.token);
  assert.equal(f.menus.epoch, epoch);
  assert.equal(staged.rpc.length, 0);
});
