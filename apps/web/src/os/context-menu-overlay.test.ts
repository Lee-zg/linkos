import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as helpers from "./context-menu";
import * as controllers from "./context-menu-controller";

// Execute the private production overlay without mounting unrelated providers.
// Only hooks/DOM are hosted here; callbacks and ownership guards stay real.
const filename = new URL("./ContextMenu.tsx", import.meta.url);
const javascript = ts.transpileModule(readFileSync(filename, "utf8"), {
  fileName: filename.pathname,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function fixture(options: { disabled?: boolean; plain?: boolean; restoreFocus?: boolean } = {}) {
  const controller = new controllers.ContextMenuController();
  const scope = controllers.createMenuScope({ kind: "shell", objectId: "window" });
  controller.registerScope(scope, { isConnected: true } as HTMLElement);
  const calls: string[] = [];
  let restored = 0;
  const target = { isConnected: true, focus: () => restored++ } as unknown as HTMLElement;
  const content: helpers.ContextMenuItem[] = [{ id: "parent", label: "Parent", disabled: options.disabled,
    restoreFocus: options.restoreFocus, onClick: () => calls.push("parent"),
    grid: options.plain ? undefined : { layout: "2x2", cells: [
      { id: "a", label: "A", onClick: () => calls.push("a") },
      { id: "b", label: "B", disabled: true, onClick: () => calls.push("b") },
      { id: "c", label: "C", onClick: () => calls.push("c") },
      { id: "d", label: "D", onClick: () => calls.push("d") },
    ] } },
    { id: "last", label: "Last", disabled: options.disabled, onClick: () => calls.push("last") }];
  const token = controller.open(scope, { anchor: { x: 10, y: 10 }, content, target,
    onClose: (_token, reason) => calls.push(reason) })!;
  const menu = controller.getSnapshot()!;
  let cursor = 0;
  const slots: any[] = [];
  let layoutEffects: (() => void)[] = [];
  let focused = -1;
  let buttons: any[] = [];
  let root: any;
  const dom = {
    focus: () => { focused = -1; },
    getBoundingClientRect: () => ({ width: 200, height: 300 }),
    querySelectorAll: () => buttons.map((_, i) => buttonDom(i)),
    querySelector: (selector: string) => {
      const index = buttons.findIndex(button => selector === `[data-menu-action-index="${button.props["data-menu-action-index"]}"]`);
      return index < 0 ? null : buttonDom(index);
    },
  };
  const buttonDom = (index: number) => ({ focus: () => {
    if (buttons[index].props.disabled) return;
    focused = index;
    buttons[index].props.onFocus?.();
  } });
  const dependencies: Record<string, any> = {
    react: {
      createContext: () => ({}),
      useRef: () => { const i = cursor++; return slots[i] ??= { current: dom }; },
      useState: (value: unknown) => {
        const i = cursor++;
        if (!(i in slots)) slots[i] = value;
        return [slots[i], (next: unknown) => { slots[i] = next; }];
      },
      useLayoutEffect: (effect: () => void, deps: unknown[]) => {
        const i = cursor++;
        if (!slots[i] || deps.some((dep, n) => !Object.is(dep, slots[i][n]))) layoutEffects.push(effect);
        slots[i] = deps;
      },
    },
    "react/jsx-runtime": { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) },
    "react-dom": {}, "./ContextMenuScope": {},
    "./context-menu": helpers, "./context-menu-controller": controllers,
  };
  const exports: any = {};
  runInNewContext(`${javascript}\nexports.Overlay = ContextMenuOverlay;`, {
    exports, require: (id: string) => {
      assert.ok(id in dependencies, `unexpected dependency: ${id}`);
      return dependencies[id];
    }, window: { innerWidth: 1000, innerHeight: 800 },
  });
  const render = () => {
    cursor = 0; layoutEffects = []; buttons = [];
    root = exports.Overlay({ menu, controller });
    const visit = (node: any, insideButton = false) => {
      if (Array.isArray(node)) { node.forEach(child => visit(child, insideButton)); return; }
      if (!node?.props) return;
      if (node.type === "button") {
        assert.equal(insideButton, false, "no nested buttons");
        buttons.push(node);
      }
      visit(node.props.children, insideButton || node.type === "button");
    };
    visit(root);
    layoutEffects.forEach(effect => effect());
  };
  render();
  return { controller, scope, calls, token, target, render,
    get focused() { return focused; }, get restored() { return restored; }, get buttons() { return buttons; },
    focus: (index: number) => buttonDom(index).focus(),
    click: (index: number) => buttons[index].props.onClick({ stopPropagation() {} }),
    key: (key: string) => {
      render();
      let prevented = false;
      root.props.onKeyDown({ key, nativeEvent: {}, target: { tagName: "BUTTON" },
        preventDefault: () => { prevented = true; }, stopPropagation() {} });
      assert.equal(prevented, true);
    },
  };
}

test("overlay End selects the final action after grid cells; Home and arrows share enabled order", () => {
  const f = fixture();
  f.key("End"); assert.equal(f.focused, 5);
  f.key("Home"); assert.equal(f.focused, 0);
  f.key("ArrowDown"); assert.equal(f.focused, 1);
  f.key("ArrowDown"); assert.equal(f.focused, 3);
  f.key("ArrowUp"); assert.equal(f.focused, 1);
  f.key("ArrowUp"); assert.equal(f.focused, 0);
  f.key("ArrowUp"); assert.equal(f.focused, 5);
  assert.deepEqual(f.buttons.map(button => button.props["data-menu-action-index"]), [0, 1, 2, 3, 4, 5]);
});

for (const key of ["Enter", " "]) test(`focused grid cell ${JSON.stringify(key)} activates exactly once with the right reason and focus`, () => {
  const f = fixture({ restoreFocus: false });
  f.focus(3);
  f.key(key);
  f.click(3); // A subsequent native click / saved handler cannot execute twice.
  assert.deepEqual(f.calls, ["activate", "c"]);
  assert.equal(f.restored, 0);
});

test("grid pointer activation executes the cell, not its parent, and restores focus", () => {
  const f = fixture();
  f.click(4); f.click(4);
  assert.deepEqual(f.calls, ["activate", "d"]);
  assert.equal(f.restored, 1);
});

for (const invalidation of ["dismiss", "replaced", "inactive"]) test(`saved overlay cell is inert after ${invalidation}`, () => {
  const f = fixture();
  if (invalidation === "dismiss") f.controller.dismiss();
  if (invalidation === "inactive") f.controller.setScopeActive(f.scope, false);
  if (invalidation === "replaced") f.controller.open(f.scope, { anchor: { x: 0, y: 0 }, content: [{ id: "new", label: "New" }] });
  const latest = f.controller.getSnapshot()?.token;
  f.click(1);
  assert.deepEqual(f.calls, ["dismiss"]);
  assert.equal(f.restored, 0);
  assert.equal(f.controller.getSnapshot()?.token, latest);
});

test("disabled cells retain indices but cannot activate; an all-disabled overlay stays on the menu", () => {
  const f = fixture({ disabled: true });
  assert.ok(f.buttons.every(button => button.props.disabled));
  for (const key of ["Home", "End", "ArrowDown", "ArrowUp", "Enter", " "]) f.key(key);
  for (let index = 0; index < f.buttons.length; index++) f.click(index);
  assert.equal(f.focused, -1);
  assert.deepEqual(f.calls, []);
  assert.equal(f.controller.getSnapshot()?.token, f.token);
});

test("plain and plugin-shaped menus preserve navigation, activation and close focus behavior", () => {
  const f = fixture({ plain: true });
  f.key("End"); assert.equal(f.focused, 1);
  f.key("Enter"); assert.deepEqual(f.calls, ["activate", "last"]);
  assert.equal(f.restored, 1);
  for (const key of ["Escape", "Tab"]) {
    const closing = fixture(); closing.key(key);
    assert.deepEqual(closing.calls, ["close"]);
    assert.equal(closing.restored, 1);
  }
});
