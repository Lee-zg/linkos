import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as api from "./context-menu-controller.js";
import { findEnabledMenuItem } from "./context-menu.js";

// DOM identity/path is supplied explicitly: no React tree or browser fallback.
function element() {
  let focused = 0;
  return { isConnected: true, focus: () => focused++, get focused() { return focused; } } as unknown as HTMLElement & { focused: number };
}
const items = [{ id: "app", label: "Application action" }];
function fixture() {
  const controller = new api.ContextMenuController();
  const desktop = api.createMenuScope({ kind: "desktop" });
  const app = api.createMenuScope({ kind: "app", appId: "files", windowId: "one" });
  const outer = element(), inner = element(), target = element();
  controller.registerScope(desktop, outer);
  controller.registerScope(app, inner);
  controller.registerGetter(desktop, outer, () => [{ id: "system", label: "System" }]);
  return { controller, desktop, app, outer, inner, target };
}
function trigger(target: HTMLElement) {
  return { source: "pointer" as const, target, anchor: { x: 0, y: 0 } };
}

describe("context menu ownership controller", () => {
  it("exports the global scope controller", () => {
    assert.equal(typeof api.ContextMenuController, "function");
  });
  it("does not fall back from an unregistered app or an unscoped portal", () => {
    const { controller: c, app, inner, outer, target } = fixture();
    assert.ok(c.trigger([outer], trigger(outer)), "desktop provider is available");
    assert.equal(c.trigger([target, inner, outer], trigger(target)), null);
    c.registerGetter(app, target, () => items); // A React portal may inherit app identity, but has no physical boundary.
    assert.equal(c.trigger([target], trigger(target)), null);
    assert.equal(c.getSnapshot(), null);
  });
  it("nearest empty getter stops resolution, including all-empty groups", () => {
    const { controller: c, app, inner, outer, target } = fixture();
    c.registerGetter(app, inner, () => items);
    for (const content of [null, [], [{ id: "empty", items: [] }]]) {
      const cleanup = c.registerGetter(app, target, () => content);
      assert.equal(c.trigger([target, inner, outer], trigger(target)), null);
      assert.equal(c.getSnapshot(), null);
      cleanup();
    }
  });
  it("preserves zero coordinates and normalizes away empty groups", () => {
    const { controller: c, app, target } = fixture();
    const token = c.open(app, { anchor: { x: 0, y: 0 }, target, content: [{ id: "empty", items: [] }, { id: "real", items }] });
    assert.ok(token);
    assert.deepEqual(c.getSnapshot()?.anchor, { x: 0, y: 0 });
    assert.deepEqual(c.getSnapshot()?.groups, [{ id: "real", items }]);
  });
  it("all disabled navigation remains -1 and activation never dereferences it", () => {
    const { controller: c, app } = fixture();
    const disabled = [{ id: "off", label: "Off", disabled: true, onClick: () => assert.fail("disabled") }];
    const token = c.open(app, { anchor: { x: 1, y: 2 }, content: disabled })!;
    assert.equal(findEnabledMenuItem(disabled, -1, "next"), -1);
    c.activate(token, -1);
    c.activate(token, 0);
    assert.equal(c.getSnapshot()?.token, token);
  });
  it("old tokens and cleanup cannot close a replacement menu", () => {
    const { controller: c, app, desktop, target } = fixture();
    const cleanup = c.registerScope(app, element());
    const old = c.open(app, { anchor: { x: 1, y: 2 }, content: items, target })!;
    const latest = c.open(desktop, { anchor: { x: 3, y: 4 }, content: items })!;
    c.close(old);
    c.dismiss(old);
    cleanup();
    assert.equal(c.getSnapshot()?.token, latest);
    assert.equal(target.focused, 0);
  });
  it("stale scope and getter cleanup do not unregister newer registrations", () => {
    const { controller: c, app, inner, target } = fixture();
    const oldScope = c.registerScope(app, inner);
    const newScope = c.registerScope(app, inner);
    const oldGetter = c.registerGetter(app, inner, () => []);
    c.registerGetter(app, inner, () => items);
    oldScope();
    oldGetter();
    assert.ok(c.trigger([target, inner], trigger(target)));
    newScope();
    assert.equal(c.isScopeActive(app), false);
    assert.equal(c.getSnapshot(), null);
  });
  it("unregistering a getter dismisses its open menu and prevents stale activation", () => {
    const { controller: c, app, inner, target } = fixture();
    let calls = 0;
    const unregister = c.registerGetter(app, inner, () => [{ ...items[0], onClick: () => calls++ }]);
    const token = c.trigger([target, inner], trigger(target))!;
    assert.ok(token);
    const epoch = c.epoch;
    unregister();
    c.activate(token, 0);
    assert.equal(calls, 0, "an unregistered provider must not execute its saved callback");
    assert.equal(c.getSnapshot(), null);
    assert.ok(c.epoch > epoch);
    assert.equal(target.focused, 0, "teardown must not restore focus");
  });
  it("getter cleanup cannot close a newer getter menu or a directly opened menu", () => {
    const { controller: c, app, inner, target } = fixture();
    const oldGetter = c.registerGetter(app, inner, () => items);
    c.trigger([target, inner], trigger(target));
    const newGetter = c.registerGetter(app, inner, () => items);
    const latest = c.trigger([target, inner], trigger(target))!;
    const epoch = c.epoch;
    oldGetter();
    assert.equal(c.getSnapshot()?.token, latest);
    assert.equal(c.epoch, epoch);
    const direct = c.open(app, { anchor: { x: 0, y: 0 }, content: items })!;
    newGetter();
    assert.equal(c.getSnapshot()?.token, direct);
  });
  it("a getter removed while resolving cannot open its saved content", () => {
    const { controller: c, app, inner, target } = fixture();
    const unregister = c.registerGetter(app, inner, () => { unregister(); return items; });
    assert.equal(c.trigger([target, inner], trigger(target)), null);
    assert.equal(c.getSnapshot(), null);
  });
  it("inactive, disconnected and silent scopes cannot open menus", () => {
    const { controller: c, app, inner } = fixture();
    c.setScopeActive(app, false);
    assert.equal(c.open(app, { anchor: { x: 0, y: 0 }, content: items }), null);
    c.setScopeActive(app, true);
    assert.equal(c.isScopeActive(app), true);
    Object.assign(inner, { isConnected: false });
    assert.equal(c.isScopeActive(app), false);
    const silent = api.createMenuScope({ kind: "silent" });
    c.registerScope(silent, element());
    assert.equal(c.open(silent, { anchor: { x: 0, y: 0 }, content: items }), null);
  });
  it("minimize/restore and scope teardown invalidate pending epochs without closing another owner", () => {
    const { controller: c, app, desktop } = fixture();
    const token = c.open(desktop, { anchor: { x: 0, y: 0 }, content: items })!;
    const pending = c.epoch;
    c.setScopeActive(app, false);
    c.setScopeActive(app, true);
    assert.ok(c.epoch > pending, "restoring a scope cannot resurrect a pending request");
    assert.equal(c.getSnapshot()?.token, token);
    const cleanup = c.registerScope(app, element());
    const beforeCleanup = c.epoch;
    cleanup();
    assert.ok(c.epoch > beforeCleanup);
    assert.equal(c.getSnapshot()?.token, token);
  });
  it("close restores only connected targets in active scopes; dismiss never restores", () => {
    const { controller: c, app, target } = fixture();
    const open = () => c.open(app, { anchor: { x: 0, y: 0 }, content: items, target });
    c.close(open()!);
    assert.equal(target.focused, 1);
    c.dismiss(open()!);
    assert.equal(target.focused, 1);
    const token = open()!;
    c.setScopeActive(app, false);
    c.close(token);
    assert.equal(target.focused, 1);
    c.setScopeActive(app, true);
    Object.assign(target, { isConnected: false });
    c.close(open()!);
    assert.equal(target.focused, 1);
  });
  it("replacement, explicit close and activation report distinct reasons with optional focus", () => {
    const { controller: c, app, target } = fixture();
    const reasons: string[] = [];
    const onClose: api.MenuOpenOptions["onClose"] = (_token, reason) => reasons.push(reason);
    c.open(app, { anchor: { x: 0, y: 0 }, content: items, target, onClose });
    c.open(app, { anchor: { x: 0, y: 0 }, content: items, target, onClose });
    c.close();
    const token = c.open(app, { anchor: { x: 0, y: 0 }, content: [{ ...items[0], restoreFocus: false }], target, onClose })!;
    c.activate(token, 0);
    assert.deepEqual(reasons, ["dismiss", "close", "activate"]);
    assert.equal(target.focused, 1);
  });
  it("new gestures and dismissal invalidate async epochs even with no visible menu", () => {
    const { controller: c, target } = fixture();
    const initial = c.epoch;
    c.dismiss();
    assert.ok(c.epoch > initial);
    const next = c.epoch;
    c.trigger([target], trigger(target));
    assert.ok(c.epoch > next);
  });
});

describe("grid action ownership", () => {
  for (const restoreFocus of [undefined, false, true]) it(`cell activation inherits focus policy (${restoreFocus}) and reports activate once`, () => {
    const { controller: c, app, target } = fixture();
    const calls: string[] = [];
    const token = c.open(app, { anchor: { x: 0, y: 0 }, target,
      onClose: (_token, reason) => calls.push(reason),
      content: [{ id: "parent", label: "Parent", restoreFocus: false, onClick: () => calls.push("parent"),
        grid: { layout: "2x2", cells: [{ id: "cell", label: "Cell", restoreFocus, onClick: () => calls.push("cell") }] } },
        { id: "last", label: "Last", onClick: () => calls.push("last") }],
    })!;
    c.activate(token, 1);
    c.activate(token, 1);
    assert.deepEqual(calls, ["activate", "cell"]);
    assert.equal(target.focused, restoreFocus === true ? 1 : 0);
  });

  it("cell focus is restored before the action and never to a disconnected target", () => {
    for (const connected of [true, false]) {
      const { controller: c, app, target } = fixture();
      Object.assign(target, { isConnected: connected });
      const token = c.open(app, { anchor: { x: 0, y: 0 }, target, content: [{ id: "parent", label: "Parent",
        grid: { layout: "2x2", cells: [{ id: "cell", label: "Cell", onClick: () => assert.equal(target.focused, connected ? 1 : 0) }] } }] })!;
      c.activate(token, 1);
      assert.equal(c.getSnapshot(), null);
    }
  });

  for (const invalidation of ["dismiss", "replace", "inactive", "disconnect", "parent-disabled", "cell-disabled"]) {
    it(`does not execute a grid callback after ${invalidation}`, () => {
      const { controller: c, app, inner, target } = fixture();
      let calls = 0;
      const token = c.open(app, { anchor: { x: 0, y: 0 }, target, content: [{ id: "parent", label: "Parent",
        disabled: invalidation === "parent-disabled", grid: { layout: "2x2", cells: [
          { id: "cell", label: "Cell", disabled: invalidation === "cell-disabled", onClick: () => calls++ },
        ] } }] })!;
      if (invalidation === "dismiss") c.dismiss();
      if (invalidation === "replace") c.open(app, { anchor: { x: 1, y: 1 }, content: items });
      if (invalidation === "inactive") c.setScopeActive(app, false);
      if (invalidation === "disconnect") Object.assign(inner, { isConnected: false });
      const latest = c.getSnapshot()?.token;
      c.activate(token, 1);
      assert.equal(calls, 0);
      assert.equal(target.focused, 0);
      if (invalidation === "replace") assert.equal(c.getSnapshot()?.token, latest);
    });
  }
});

function eventsFixture() {
  const f = fixture();
  const doc = Object.assign(new EventTarget(), { defaultView: new EventTarget() });
  Object.assign(f.target, { offsetWidth: 20, getBoundingClientRect: () => ({ left: 12, bottom: 34 }) });
  const path = [f.target, f.inner, f.outer];
  const send = (type: string, props = {}, nodes: EventTarget[] = path, prevented = false) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { composedPath: () => nodes, ...props });
    if (prevented) event.preventDefault();
    doc.dispatchEvent(event);
    return event;
  };
  f.controller.registerGetter(f.app, f.inner, () => items);
  const cleanup = api.bindContextMenuEvents(f.controller, doc as unknown as Document);
  return { ...f, doc, send, cleanup };
}

describe("document capture gestures", () => {
  it("routes already-prevented gestures, and keeps pointer coordinate zero", () => {
    const { controller: c, send, cleanup } = eventsFixture();
    const event = send("contextmenu", { clientX: 0, clientY: 0, button: 2 }, undefined, true);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(c.getSnapshot()?.anchor, { x: 0, y: 0 });
    cleanup();
  });
  it("keyboard uses the target rect, suppresses its companion and ignores IME", () => {
    const { controller: c, send, cleanup } = eventsFixture();
    assert.equal(send("keydown", { key: "F10", shiftKey: true }).defaultPrevented, true);
    assert.deepEqual(c.getSnapshot()?.anchor, { x: 12, y: 34 });
    const token = c.getSnapshot()?.token;
    send("contextmenu", { clientX: 0, clientY: 0, button: 0 });
    assert.equal(c.getSnapshot()?.token, token);
    // Some engines report button=2 even for a keyboard-generated contextmenu.
    send("contextmenu", { clientX: 0, clientY: 0, button: 2 });
    assert.equal(c.getSnapshot()?.token, token);
    c.dismiss();
    send("keydown", { key: "ContextMenu", isComposing: true });
    assert.equal(c.getSnapshot(), null);
    assert.equal(send("keydown", { key: "c", ctrlKey: true }).defaultPrevented, false);
    cleanup();
  });
  for (const key of ["F10", "ContextMenu", "Escape", "Tab"]) it(`composing ${key} is neither consumed nor used to invalidate menus`, () => {
    const { controller: c, send, target, cleanup } = eventsFixture();
    let stopped = false;
    const epoch = c.epoch;
    const event = send("keydown", { key, shiftKey: key === "F10", isComposing: true, stopPropagation: () => { stopped = true; } });
    assert.equal(event.defaultPrevented, false);
    assert.equal(stopped, false);
    assert.equal(c.epoch, epoch);
    assert.equal(c.getSnapshot(), null);
    // Native contextmenu cancellation is independent of IME key handling.
    assert.equal(send("contextmenu", {}, [target]).defaultPrevented, true);
    cleanup();
  });
  for (const key of ["Escape", "Tab"]) it(`${key} invalidates a pending open without consuming the application key`, async () => {
    const { controller: c, app, send, target, cleanup } = eventsFixture();
    const epoch = c.epoch;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }).then(() => {
      if (c.epoch === epoch) c.open(app, { anchor: { x: 0, y: 0 }, content: items, target });
    });
    let stopped = false;
    const event = send("keydown", { key, stopPropagation: () => { stopped = true; } });
    release();
    await pending;
    assert.equal(c.getSnapshot(), null, "dismissed asynchronous content cannot resurrect a menu");
    assert.ok(c.epoch > epoch);
    assert.equal(event.defaultPrevented, false);
    assert.equal(stopped, false);
    assert.equal(target.focused, 0);
    cleanup();
  });
  for (const key of ["Escape", "Tab"]) it(`${key} leaves a visible menu to overlay close and focus restoration`, () => {
    const { controller: c, app, send, target, cleanup } = eventsFixture();
    const reasons: string[] = [];
    const token = c.open(app, { anchor: { x: 0, y: 0 }, content: items, target, onClose: (_token, reason) => reasons.push(reason) })!;
    const menu = c.getSnapshot()!;
    assert.equal(menu.token, token);
    const epoch = c.epoch;
    const overlay = Object.assign(element(), { hasAttribute: (name: string) => name === "data-context-menu-overlay" });
    let stopped = false;
    const event = send("keydown", { key, stopPropagation: () => { stopped = true; } }, [overlay]);
    assert.equal(c.getSnapshot()?.token, menu.token);
    assert.equal(c.epoch, epoch);
    assert.equal(event.defaultPrevented, false);
    assert.equal(stopped, false);
    c.close(menu.token); // The overlay receives the event and owns this close.
    assert.deepEqual(reasons, ["close"]);
    assert.equal(target.focused, 1);
    cleanup();
  });
  it("outside pointerdown, scroll, resize and blur invalidate pending epochs with no menu", () => {
    const { controller: c, send, doc, cleanup } = eventsFixture();
    for (const type of ["pointerdown", "scroll", "resize", "blur"]) {
      const epoch = c.epoch;
      if (type === "resize" || type === "blur") doc.defaultView.dispatchEvent(new Event(type));
      else send(type);
      assert.ok(c.epoch > epoch, type);
    }
    cleanup();
    const epoch = c.epoch;
    send("pointerdown");
    doc.defaultView.dispatchEvent(new Event("blur"));
    assert.equal(c.epoch, epoch);
  });
  it("menu pointerdown and right click do not invalidate or reopen the current menu", () => {
    const { controller: c, send, cleanup } = eventsFixture();
    send("contextmenu", { button: 2, clientX: 1, clientY: 2 });
    const epoch = c.epoch;
    const overlay = Object.assign(element(), { hasAttribute: (name: string) => name === "data-context-menu-overlay" });
    send("pointerdown", {}, [overlay]);
    assert.equal(send("contextmenu", { button: 2 }, [overlay]).defaultPrevented, true);
    assert.equal(c.epoch, epoch);
    cleanup();
  });
  it("unscoped editors still suppress browser menus without suppressing typing", () => {
    const { controller: c, target, send, cleanup } = eventsFixture();
    assert.equal(send("contextmenu", {}, [target]).defaultPrevented, true);
    assert.equal(send("keydown", { key: "ContextMenu" }, [target]).defaultPrevented, true);
    assert.equal(send("keydown", { key: "Delete" }, [target]).defaultPrevented, false);
    assert.equal(c.getSnapshot(), null);
    cleanup();
  });
});
