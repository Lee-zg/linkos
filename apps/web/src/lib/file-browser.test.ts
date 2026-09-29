import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialNavigation,
  navigateForward,
  navigateBack,
  navigateForwardInHistory,
  canGoBack,
  canGoForward,
  getAncestorPath,
  sortResources,
  filterResources,
  formatFileSize,
  formatRelativeTime,
  validateFileName,
} from "./file-browser.js";
import type { ResourceRecord } from "@linkos/protocol";
import * as helpers from "./file-browser.js";

describe("file browser contract helpers", () => {
  it("validates stored preferences rather than trusting arbitrary JSON", () => {
    assert.deepEqual(helpers.parseFilePreferences('{"viewMode":"oops","sortField":"size","sortOrder":"no"}'), { viewMode: "list", sortField: "size", sortOrder: "asc" });
    assert.deepEqual(helpers.parseFilePreferences("null"), { viewMode: "list", sortField: "name", sortOrder: "asc" });
    assert.deepEqual(helpers.parseFilePreferences("broken"), { viewMode: "list", sortField: "name", sortOrder: "asc" });
  });
  it("isolates preferences by gateway, workspace and user without separator collisions", () => {
    const key = helpers.filePreferencesKey("https://gateway", "demo", "user");
    assert.notEqual(key, helpers.filePreferencesKey("https://other", "demo", "user"));
    assert.notEqual(key, helpers.filePreferencesKey("https://gateway", "other", "user"));
    assert.notEqual(key, helpers.filePreferencesKey("https://gateway", "demo", "other"));
    assert.notEqual(helpers.filePreferencesKey("a/b", "c", "d"), helpers.filePreferencesKey("a", "b/c", "d"));
  });
  it("uses hashed bytes for hashing progress rather than upload parts", () => {
    assert.equal(helpers.fileTransferPercent({ phase: "hashing", hashedBytes: 25, sentBytes: 0, totalBytes: 100 }), 25);
    assert.equal(helpers.fileTransferPercent({ phase: "uploading", hashedBytes: 100, sentBytes: 30, totalBytes: 100 }), 30);
    assert.equal(helpers.fileTransferPercent({ phase: "finalizing", hashedBytes: 0, sentBytes: 0, totalBytes: 0 }), 100);
  });
});

describe("navigation history", () => {
  it("creates initial navigation at root", () => {
    const nav = createInitialNavigation();
    assert.equal(nav.historyIndex, 0);
    assert.deepEqual(nav.history, [""]);
  });

  it("navigates forward to a folder", () => {
    const nav = createInitialNavigation();
    const next = navigateForward(nav, "folder-1");
    assert.equal(next.historyIndex, 1);
    assert.deepEqual(next.history, ["", "folder-1"]);
  });

  it("truncates forward history when navigating forward", () => {
    const nav = createInitialNavigation();
    const step1 = navigateForward(nav, "folder-1");
    const step2 = navigateForward(step1, "folder-2");
    const back = navigateBack(step2);
    const forward = navigateForward(back, "folder-3");
    assert.deepEqual(forward.history, ["", "folder-1", "folder-3"]);
    assert.equal(forward.historyIndex, 2);
  });

  it("navigates back within history", () => {
    const nav = createInitialNavigation();
    const step1 = navigateForward(nav, "folder-1");
    const back = navigateBack(step1);
    assert.equal(back.historyIndex, 0);
  });

  it("does not go back past root", () => {
    const nav = createInitialNavigation();
    const back = navigateBack(nav);
    assert.equal(back.historyIndex, 0);
  });

  it("navigates forward in history", () => {
    const nav = createInitialNavigation();
    const step1 = navigateForward(nav, "folder-1");
    const back = navigateBack(step1);
    const forward = navigateForwardInHistory(back);
    assert.equal(forward.historyIndex, 1);
  });

  it("does not go forward past end", () => {
    const nav = createInitialNavigation();
    const forward = navigateForwardInHistory(nav);
    assert.equal(forward.historyIndex, 0);
  });

  it("canGoBack returns false at root", () => {
    const nav = createInitialNavigation();
    assert.equal(canGoBack(nav), false);
  });

  it("canGoBack returns true after navigation", () => {
    const nav = createInitialNavigation();
    const step1 = navigateForward(nav, "folder-1");
    assert.equal(canGoBack(step1), true);
  });

  it("canGoForward returns false at end", () => {
    const nav = createInitialNavigation();
    assert.equal(canGoForward(nav), false);
  });

  it("canGoForward returns true after going back", () => {
    const nav = createInitialNavigation();
    const step1 = navigateForward(nav, "folder-1");
    const back = navigateBack(step1);
    assert.equal(canGoForward(back), true);
  });

  it("getAncestorPath returns path up to current index", () => {
    const nav = createInitialNavigation();
    const step1 = navigateForward(nav, "folder-1");
    const step2 = navigateForward(step1, "folder-2");
    const path = getAncestorPath(step2);
    assert.deepEqual(path, ["", "folder-1", "folder-2"]);
  });
});

describe("sortResources", () => {
  const createResource = (overrides: Partial<ResourceRecord>): ResourceRecord => ({
    id: "res_1",
    workspaceId: "demo",
    type: "file",
    name: "test.txt",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  });

  it("sorts folders before files", () => {
    const items = [
      createResource({ id: "1", name: "file.txt", type: "file" }),
      createResource({ id: "2", name: "folder", type: "folder" }),
    ];
    const sorted = sortResources(items, "name", "asc");
    assert.equal(sorted[0].type, "folder");
    assert.equal(sorted[1].type, "file");
  });

  it("sorts by name ascending", () => {
    const items = [
      createResource({ id: "1", name: "zebra.txt" }),
      createResource({ id: "2", name: "apple.txt" }),
    ];
    const sorted = sortResources(items, "name", "asc");
    assert.equal(sorted[0].name, "apple.txt");
    assert.equal(sorted[1].name, "zebra.txt");
  });

  it("sorts by name descending", () => {
    const items = [
      createResource({ id: "1", name: "apple.txt" }),
      createResource({ id: "2", name: "zebra.txt" }),
    ];
    const sorted = sortResources(items, "name", "desc");
    assert.equal(sorted[0].name, "zebra.txt");
    assert.equal(sorted[1].name, "apple.txt");
  });

  it("sorts by updatedAt", () => {
    const items = [
      createResource({ id: "1", name: "old.txt", updatedAt: "2024-01-01T00:00:00Z" }),
      createResource({ id: "2", name: "new.txt", updatedAt: "2024-01-02T00:00:00Z" }),
    ];
    const sorted = sortResources(items, "updatedAt", "desc");
    assert.equal(sorted[0].name, "new.txt");
  });

  it("sorts by size from meta", () => {
    const items = [
      createResource({ id: "1", name: "small.txt", meta: { size: 100 } }),
      createResource({ id: "2", name: "large.txt", meta: { size: 1000 } }),
    ];
    const sorted = sortResources(items, "size", "asc");
    assert.equal(sorted[0].name, "small.txt");
  });

  it("uses numeric comparison for names with numbers", () => {
    const items = [
      createResource({ id: "1", name: "file10.txt" }),
      createResource({ id: "2", name: "file2.txt" }),
    ];
    const sorted = sortResources(items, "name", "asc");
    assert.equal(sorted[0].name, "file2.txt");
    assert.equal(sorted[1].name, "file10.txt");
  });
});

describe("filterResources", () => {
  const createResource = (name: string): ResourceRecord => ({
    id: "res_1",
    workspaceId: "demo",
    type: "file",
    name,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  });

  it("returns all items when query is empty", () => {
    const items = [createResource("a.txt"), createResource("b.txt")];
    const filtered = filterResources(items, "");
    assert.equal(filtered.length, 2);
  });

  it("filters by name case-insensitively", () => {
    const items = [createResource("README.md"), createResource("test.txt")];
    const filtered = filterResources(items, "readme");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, "README.md");
  });

  it("returns empty array when no match", () => {
    const items = [createResource("test.txt")];
    const filtered = filterResources(items, "xyz");
    assert.equal(filtered.length, 0);
  });
});

describe("formatFileSize", () => {
  it("formats bytes", () => {
    assert.equal(formatFileSize(500), "500 B");
  });

  it("formats kilobytes", () => {
    assert.equal(formatFileSize(1500), "1.5 KB");
  });

  it("formats megabytes", () => {
    assert.equal(formatFileSize(1500000), "1.4 MB");
  });

  it("formats gigabytes", () => {
    assert.equal(formatFileSize(1500000000), "1.40 GB");
  });
});

describe("formatRelativeTime", () => {
  it("formats recent time as 刚刚", () => {
    const now = new Date().toISOString();
    assert.equal(formatRelativeTime(now), "刚刚");
  });

  it("formats minutes ago", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.equal(formatRelativeTime(fiveMinutesAgo), "5 分钟前");
  });

  it("formats hours ago", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    assert.equal(formatRelativeTime(twoHoursAgo), "2 小时前");
  });

  it("formats days ago", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(formatRelativeTime(threeDaysAgo), "3 天前");
  });
});

describe("validateFileName", () => {
  it("accepts valid names", () => {
    assert.equal(validateFileName("test.txt").valid, true);
    assert.equal(validateFileName("我的文件").valid, true);
  });

  it("rejects empty names", () => {
    const result = validateFileName("");
    assert.equal(result.valid, false);
    assert.ok(result.error?.includes("空"));
  });

  it("rejects whitespace-only names", () => {
    const result = validateFileName("   ");
    assert.equal(result.valid, false);
  });

  it("rejects . and ..", () => {
    assert.equal(validateFileName(".").valid, false);
    assert.equal(validateFileName("..").valid, false);
  });

  it("rejects names with slashes", () => {
    assert.equal(validateFileName("path/file").valid, false);
    assert.equal(validateFileName("path\\file").valid, false);
  });

  it("rejects names with control characters", () => {
    assert.equal(validateFileName("test\x00file").valid, false);
  });

  it("rejects names over 255 bytes", () => {
    const longName = "a".repeat(256);
    assert.equal(validateFileName(longName).valid, false);
  });

  it("accepts names at exactly 255 bytes", () => {
    const exactName = "a".repeat(255);
    assert.equal(validateFileName(exactName).valid, true);
  });
});
