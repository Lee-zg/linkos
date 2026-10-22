import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeMenuPosition,
  isEditableElement,
  findEnabledMenuItem,
  normalizeMenuContent,
  type ContextMenuItem,
  type ContextMenuGroup,
} from "./context-menu.js";

describe("computeMenuPosition", () => {
  const viewport = { width: 1024, height: 768 };

  it("clamps negative trigger coordinates", () => {
    assert.deepEqual(computeMenuPosition({ x: -10, y: -20 }, { width: 100, height: 80 }, viewport), { x: 0, y: 0 });
  });

  it("recognizes readonly CodeMirror descendants as editors for file shortcut safety", () => {
    const element = { tagName: "SPAN", closest: (selector: string) => selector.includes(".cm-editor") ? {} : null } as unknown as HTMLElement;
    assert.equal(isEditableElement(element), true);
  });

  it("starts ArrowUp at the final enabled item", () => {
    assert.equal(findEnabledMenuItem([{ id: "first" }, { id: "last" }], -1, "prev"), 1);
  });

  it("returns trigger position when menu fits in viewport", () => {
    const trigger = { x: 100, y: 100 };
    const menu = { width: 200, height: 300 };
    const result = computeMenuPosition(trigger, menu, viewport);
    assert.deepEqual(result, { x: 100, y: 100 });
  });

  it("clamps right edge to viewport", () => {
    const trigger = { x: 900, y: 100 };
    const menu = { width: 200, height: 300 };
    const result = computeMenuPosition(trigger, menu, viewport);
    assert.equal(result.x, 824);
    assert.equal(result.y, 100);
  });

  it("clamps bottom edge to viewport", () => {
    const trigger = { x: 100, y: 600 };
    const menu = { width: 200, height: 300 };
    const result = computeMenuPosition(trigger, menu, viewport);
    assert.equal(result.x, 100);
    assert.equal(result.y, 468);
  });

  it("clamps both edges when trigger is at bottom-right", () => {
    const trigger = { x: 900, y: 600 };
    const menu = { width: 200, height: 300 };
    const result = computeMenuPosition(trigger, menu, viewport);
    assert.equal(result.x, 824);
    assert.equal(result.y, 468);
  });

  it("handles zero-size menu", () => {
    const trigger = { x: 100, y: 100 };
    const menu = { width: 0, height: 0 };
    const result = computeMenuPosition(trigger, menu, viewport);
    assert.deepEqual(result, { x: 100, y: 100 });
  });

  it("handles menu larger than viewport", () => {
    const trigger = { x: 100, y: 100 };
    const menu = { width: 2000, height: 2000 };
    const result = computeMenuPosition(trigger, menu, viewport);
    assert.equal(result.x, 0);
    assert.equal(result.y, 0);
  });
});

describe("isEditableElement", () => {
  it("returns true for input element", () => {
    const element = { tagName: "INPUT" } as HTMLElement;
    assert.equal(isEditableElement(element), true);
  });

  it("returns true for textarea element", () => {
    const element = { tagName: "TEXTAREA" } as HTMLElement;
    assert.equal(isEditableElement(element), true);
  });

  it("returns true for contenteditable element", () => {
    const element = { tagName: "DIV", isContentEditable: true } as HTMLElement;
    assert.equal(isEditableElement(element), true);
  });

  it("returns false for regular div", () => {
    const element = { tagName: "DIV", isContentEditable: false } as HTMLElement;
    assert.equal(isEditableElement(element), false);
  });

  it("returns false for null", () => {
    assert.equal(isEditableElement(null), false);
  });

  it("returns false for undefined", () => {
    assert.equal(isEditableElement(undefined), false);
  });
});

describe("findEnabledMenuItem", () => {
  type MenuItem = { id: string; disabled?: boolean };

  it("moves to next enabled item", () => {
    const items: MenuItem[] = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ];
    const result = findEnabledMenuItem(items, 0, "next");
    assert.equal(result, 1);
  });

  it("skips disabled item going next", () => {
    const items: MenuItem[] = [
      { id: "a", disabled: true },
      { id: "b" },
      { id: "c" },
    ];
    const result = findEnabledMenuItem(items, 0, "next");
    assert.equal(result, 1);
  });

  it("skips disabled item going prev", () => {
    const items: MenuItem[] = [
      { id: "a" },
      { id: "b" },
      { id: "c", disabled: true },
    ];
    const result = findEnabledMenuItem(items, 2, "prev");
    assert.equal(result, 1);
  });

  it("wraps around when going next from last", () => {
    const items: MenuItem[] = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ];
    const result = findEnabledMenuItem(items, 2, "next");
    assert.equal(result, 0);
  });

  it("wraps around when going prev from first", () => {
    const items: MenuItem[] = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ];
    const result = findEnabledMenuItem(items, 0, "prev");
    assert.equal(result, 2);
  });

  it("returns -1 when all items disabled", () => {
    const items: MenuItem[] = [
      { id: "a", disabled: true },
      { id: "b", disabled: true },
    ];
    const result = findEnabledMenuItem(items, 0, "next");
    assert.equal(result, -1);
  });

  it("returns -1 for empty array", () => {
    const items: MenuItem[] = [];
    const result = findEnabledMenuItem(items, 0, "next");
    assert.equal(result, -1);
  });
});

// --- Phase 5: Grid layout metadata for context menu items ---

describe("grid layout metadata", () => {
  it("ContextMenuItem supports optional grid metadata for layout presentation", () => {
    const item: ContextMenuItem = {
      id: "fill",
      label: "Fill & Arrange",
      grid: {
        layout: "2x2",
        cells: [
          { id: "top-left", label: "左上", placement: "top-left" },
          { id: "top-right", label: "右上", placement: "top-right" },
          { id: "bottom-left", label: "左下", placement: "bottom-left" },
          { id: "bottom-right", label: "右下", placement: "bottom-right" },
        ],
      },
    };
    assert.equal(item.grid?.layout, "2x2");
    assert.equal(item.grid?.cells.length, 4);
    assert.equal(item.grid?.cells[0].placement, "top-left");
  });

  it("ContextMenuItem without grid metadata remains a standard menu item", () => {
    const item: ContextMenuItem = {
      id: "close",
      label: "Close",
    };
    assert.equal(item.grid, undefined);
  });

  it("normalizeMenuContent preserves grid metadata through groups", () => {
    const items: ContextMenuItem[] = [
      {
        id: "fill",
        label: "Fill",
        grid: { layout: "2x2", cells: [{ id: "tl", label: "TL", placement: "top-left" }] },
      },
      { id: "close", label: "Close" },
    ];
    const groups = normalizeMenuContent(items);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 2);
    assert.ok(groups[0].items[0].grid);
    assert.equal(groups[0].items[0].grid?.layout, "2x2");
    assert.equal(groups[0].items[1].grid, undefined);
  });

  it("normalizeMenuContent preserves grid metadata in group input", () => {
    const groups: ContextMenuGroup[] = [
      {
        id: "layout",
        items: [
          {
            id: "half-left",
            label: "Left Half",
            grid: { layout: "1x2", cells: [{ id: "left", label: "L", placement: "left" }] },
          },
        ],
      },
    ];
    const result = normalizeMenuContent(groups);
    assert.equal(result.length, 1);
    assert.ok(result[0].items[0].grid);
  });
});
