import type { ResourceRecord } from "@linkos/protocol";

export type ViewMode = "list" | "grid";
export type SortField = "name" | "updatedAt" | "size";
export type SortOrder = "asc" | "desc";

export interface FileBrowserPreferences {
  viewMode: ViewMode;
  sortField: SortField;
  sortOrder: SortOrder;
}

export function filePreferencesKey(gateway: string, workspace: string, user: string): string {
  return `linkos.fileBrowser.preferences:${JSON.stringify([gateway, workspace, user])}`;
}

export function parseFilePreferences(raw: string | null): FileBrowserPreferences {
  let value: Partial<FileBrowserPreferences> = {};
  try { value = JSON.parse(raw ?? "{}") ?? {}; } catch { /* invalid storage uses defaults */ }
  return {
    viewMode: value.viewMode === "grid" ? "grid" : "list",
    sortField: value.sortField === "size" || value.sortField === "updatedAt" ? value.sortField : "name",
    sortOrder: value.sortOrder === "desc" ? "desc" : "asc",
  };
}

export function fileTransferPercent(progress: { phase: string; hashedBytes: number; sentBytes: number; totalBytes: number }): number {
  if (progress.phase === "finalizing") return 100;
  if (progress.totalBytes <= 0) return 0;
  const bytes = progress.phase === "hashing" ? progress.hashedBytes : progress.sentBytes;
  return Math.max(0, Math.min(100, Math.round(bytes / progress.totalBytes * 100)));
}

export interface NavigationState {
  history: string[];
  historyIndex: number;
}

export function createInitialNavigation(): NavigationState {
  return { history: [""], historyIndex: 0 };
}

export function navigateForward(
  nav: NavigationState,
  parentId: string,
): NavigationState {
  const newHistory = [...nav.history.slice(0, nav.historyIndex + 1), parentId];
  return { history: newHistory, historyIndex: newHistory.length - 1 };
}

export function navigateBack(nav: NavigationState): NavigationState {
  if (nav.historyIndex <= 0) return nav;
  return { ...nav, historyIndex: nav.historyIndex - 1 };
}

export function navigateForwardInHistory(nav: NavigationState): NavigationState {
  if (nav.historyIndex >= nav.history.length - 1) return nav;
  return { ...nav, historyIndex: nav.historyIndex + 1 };
}

export function canGoBack(nav: NavigationState): boolean {
  return nav.historyIndex > 0;
}

export function canGoForward(nav: NavigationState): boolean {
  return nav.historyIndex < nav.history.length - 1;
}

export function getAncestorPath(
  nav: NavigationState,
): string[] {
  return nav.history.slice(0, nav.historyIndex + 1);
}

export function sortResources(
  items: ResourceRecord[],
  field: SortField,
  order: SortOrder,
): ResourceRecord[] {
  const sorted = [...items].sort((a, b) => {
    const aIsFolder = a.type === "folder";
    const bIsFolder = b.type === "folder";

    if (aIsFolder !== bIsFolder) {
      return aIsFolder ? -1 : 1;
    }

    let comparison = 0;
    if (field === "name") {
      comparison = a.name.localeCompare(b.name, undefined, { numeric: true });
    } else if (field === "updatedAt") {
      comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    } else if (field === "size") {
      const aSize = typeof a.meta?.size === "number" ? a.meta.size : 0;
      const bSize = typeof b.meta?.size === "number" ? b.meta.size : 0;
      comparison = aSize - bSize;
    }

    return order === "asc" ? comparison : -comparison;
  });

  return sorted;
}

export function filterResources(
  items: ResourceRecord[],
  query: string,
): ResourceRecord[] {
  if (!query.trim()) return items;
  const normalized = query.toLowerCase();
  return items.filter((item) => item.name.toLowerCase().includes(normalized));
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;
  return date.toLocaleDateString("zh-CN");
}

export function validateFileName(name: string): { valid: boolean; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, error: "名称不能为空" };
  }
  if (trimmed === "." || trimmed === "..") {
    return { valid: false, error: "不能使用 . 或 .." };
  }
  if (/[\/\\]/.test(trimmed)) {
    return { valid: false, error: "名称不能包含斜杠" };
  }
  if (/[\x00-\x1f]/.test(trimmed)) {
    return { valid: false, error: "名称不能包含控制字符" };
  }
  const utf8Bytes = new TextEncoder().encode(trimmed).length;
  if (utf8Bytes > 255) {
    return { valid: false, error: "名称不能超过 255 字节" };
  }
  return { valid: true };
}
