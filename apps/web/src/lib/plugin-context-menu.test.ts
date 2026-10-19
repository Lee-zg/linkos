import { test } from "node:test";
import assert from "node:assert/strict";
import * as helpers from "./plugin-context-menu.js";

const commands = new Map([["refresh", { title: "Refresh" }]]);
const viewport = { width: 500, height: 300 };
const request = () => ({
  seq: 1,
  registrationId: "list",
  anchor: { x: 0, y: 0 },
  groups: [{ id: "main", items: [{ commandId: "refresh" }] }],
});

test("plugin menu accepts only its registered commands and preserves zero anchors", () => {
  assert.equal(typeof helpers.parsePluginMenu, "function");
  assert.deepEqual(
    helpers.parsePluginMenu(request(), commands, viewport),
    request(),
  );
  assert.throws(() =>
    helpers.parsePluginMenu(
      {
        ...request(),
        groups: [{ id: "main", items: [{ commandId: "system.settings" }] }],
      },
      commands,
      viewport,
    ),
  );
});

test("plugin menu rejects malformed shapes, duplicated commands, excessive items and coordinates", () => {
  assert.equal(typeof helpers.parsePluginMenu, "function");
  for (const value of [
    null,
    [],
    {},
    { ...request(), seq: 1.2 },
    { ...request(), seq: Infinity },
    { ...request(), registrationId: "x".repeat(101) },
    { ...request(), anchor: { x: NaN, y: 0 } },
    { ...request(), anchor: { x: 501, y: 0 } },
    { ...request(), anchor: { x: 0, y: -1 } },
    {
      ...request(),
      groups: Array.from({ length: 9 }, () => ({ id: "empty", items: [] })),
    },
    {
      ...request(),
      groups: [
        {
          id: "a",
          items: [{ commandId: "refresh" }, { commandId: "refresh" }],
        },
      ],
    },
    {
      ...request(),
      groups: [{ id: "a", items: [{ commandId: "refresh", disabled: "yes" }] }],
    },
  ]) {
    assert.throws(() => helpers.parsePluginMenu(value, commands, viewport));
  }
});

test("iframe anchors account for scale and border offsets", () => {
  assert.equal(typeof helpers.pluginMenuAnchor, "function");
  assert.deepEqual(
    helpers.pluginMenuAnchor(
      { x: 20, y: 10 },
      { left: 100, top: 80, width: 1000, height: 600 },
      { offsetWidth: 500, offsetHeight: 300, clientLeft: 2, clientTop: 2 },
    ),
    { x: 144, y: 104 },
  );
});

test("cancellation and new requests make delayed plugin menus stale without cancelling another request", () => {
  assert.equal(typeof helpers.PluginMenuRequests, "function");
  const requests = new helpers.PluginMenuRequests();
  const first = requests.begin(1);
  assert.ok(first);
  requests.cancel(1);
  assert.equal(requests.isCurrent(first), false);
  const next = requests.begin(2);
  assert.ok(next);
  requests.cancel(1);
  assert.equal(requests.isCurrent(next), true);
  assert.equal(requests.begin(1), null);
  requests.invalidate();
  assert.equal(requests.isCurrent(next), false);
});

test("rejected sequences and old close callbacks preserve the newly admitted ticket", () => {
  const requests = new helpers.PluginMenuRequests();
  const first = requests.begin(1)!;
  const current = requests.begin(2)!;
  assert.equal(requests.isCurrent(first), false);
  for (const seq of [1, 2, 0, -1, 1.5, NaN, Infinity]) {
    assert.equal(requests.begin(seq), null);
    assert.equal(requests.isCurrent(current), true);
  }
  assert.equal(requests.cancel(first.seq), false);
  assert.equal(requests.isCurrent(current), true);
  assert.equal(requests.cancel(current.seq), true);
  assert.equal(requests.isCurrent(current), false);
  assert.equal(requests.begin(2), null);
  assert.ok(requests.begin(3));
});

test("plugin menu keeps the eight-group and 32-total-command boundaries", () => {
  const registered = new Map(
    Array.from({ length: 33 }, (_, i) => [
      `cmd-${i}`,
      { title: `Command ${i}` },
    ]),
  );
  const groups = Array.from({ length: 8 }, (_, group) => ({
    id: `group-${group}`,
    items: Array.from({ length: 4 }, (_, item) => ({
      commandId: `cmd-${group * 4 + item}`,
    })),
  }));
  const maximum = { ...request(), groups };
  assert.deepEqual(
    helpers.parsePluginMenu(maximum, registered, viewport),
    maximum,
  );
  assert.throws(() =>
    helpers.parsePluginMenu(
      {
        ...maximum,
        groups: [...groups, { id: "ninth", items: [] }],
      },
      registered,
      viewport,
    ),
  );
  assert.throws(() =>
    helpers.parsePluginMenu(
      {
        ...maximum,
        groups: groups.map((group, index) =>
          index === 0
            ? { ...group, items: [...group.items, { commandId: "cmd-32" }] }
            : group,
        ),
      },
      registered,
      viewport,
    ),
  );
});
