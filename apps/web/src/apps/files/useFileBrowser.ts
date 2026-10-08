import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getGatewayBase, listResources, type FileResource, type ResourceListing } from "../../lib/api";
import { filePreferencesKey, parseFilePreferences, selectFileRange, type FileBrowserPreferences, type SortField, type SortOrder, type ViewMode } from "../../lib/file-browser";
import { useSession } from "../../lib/session";
import { useWorkspace } from "../../lib/workspace";

export type { SortField, SortOrder, ViewMode } from "../../lib/file-browser";
type Ancestor = ResourceListing["ancestors"][number];
interface FileBrowserState extends FileBrowserPreferences {
  currentParentId: string;
  items: FileResource[];
  selectedIds: Set<string>;
  searchQuery: string;
  recent: boolean;
  loading: boolean;
  hasLoaded: boolean;
  error: string | null;
  notice: string | null;
  nextCursor: string | null;
  total: number;
  ancestors: Ancestor[];
  canRead: boolean;
  canWrite: boolean;
  canCreateChild: boolean;
  history: string[];
  historyIndex: number;
}

function readPreferences(key: string | null): FileBrowserPreferences {
  try { return parseFilePreferences(key ? localStorage.getItem(key) : null); }
  catch { return parseFilePreferences(null); }
}

export function useFileBrowser({ persistPreferences = true }: { persistPreferences?: boolean } = {}) {
  const { connected, directoryVersion } = useWorkspace();
  const { profile } = useSession();
  const preferenceKey = persistPreferences ? filePreferencesKey(getGatewayBase() || window.location.origin, profile.workspaceId, profile.userId) : null;
  const [state, setState] = useState<FileBrowserState>(() => ({
    ...readPreferences(preferenceKey), currentParentId: "", items: [], selectedIds: new Set(), searchQuery: "", recent: false,
    loading: true, hasLoaded: false, error: null, notice: null, nextCursor: null, total: 0, ancestors: [],
    canRead: false, canWrite: false, canCreateChild: false, history: [""], historyIndex: 0,
  }));
  // All async commands read the latest location. A completion from an old upload/mutation
  // can refresh the current view, but must never resurrect its captured directory.
  const current = useRef(state);
  const online = useRef(connected);
  online.current = connected;
  const requestId = useRef(0);
  const selectionAnchor = useRef<string | null>(null);
  const paths = useRef(new Map<string, Ancestor[]>([["", []]]));
  const update = useCallback((patch: Partial<FileBrowserState>) => {
    current.current = { ...current.current, ...patch };
    setState(current.current);
  }, []);

  const fetchItems = useCallback(async (append = false) => {
    const before = current.current;
    if (append && (!before.nextCursor || before.loading)) return;
    const id = ++requestId.current;
    if (!online.current) { update({ loading: false }); return; }
    let parentId = before.currentParentId;
    let cursor = append ? before.nextCursor : null;
    const fallback = [...before.ancestors].reverse().filter(a => a.id !== parentId).map(a => a.id);
    if (parentId) fallback.push("");
    let recovered = false;
    update({ loading: true, error: null, ...(!append ? { nextCursor: null } : {}) });
    while (id === requestId.current) {
      try {
        const response = await listResources({
          scope: "files", parentId, recent: before.recent || undefined,
          q: recovered ? undefined : before.searchQuery || undefined,
          sortBy: before.sortField, sortOrder: before.sortOrder, cursor: cursor ?? undefined, limit: 50,
        });
        if (id !== requestId.current) return;
        if (response.canRead === false) throw new ApiError(403, "无权读取此目录");
        const ancestors = response.ancestors ?? [];
        paths.current.set(parentId, ancestors);
        for (let i = 0; i < ancestors.length; i++) paths.current.set(ancestors[i].id, ancestors.slice(0, i + 1));
        const items = cursor ? [...current.current.items, ...response.items.filter(item => !current.current.items.some(old => old.id === item.id))] : response.items;
        const history = recovered ? [...before.history.slice(0, before.historyIndex + 1), parentId] : before.history;
        update({
          currentParentId: parentId, items, nextCursor: response.nextCursor || null, total: response.total ?? items.length,
          ancestors, canRead: response.canRead === true, canWrite: response.canWrite === true,
          canCreateChild: response.canCreateChild === true, loading: false, hasLoaded: true,
          selectedIds: new Set([...current.current.selectedIds].filter(selected => items.some(item => item.id === selected))),
          ...(recovered ? { searchQuery: "", history, historyIndex: history.length - 1, notice: "当前目录已被移走、删除或不可访问，已返回最近可访问的上级目录。" } : {}),
        });
        return;
      } catch (error) {
        if (id !== requestId.current) return;
        if (cursor && error instanceof ApiError && /CURSOR.*STALE|STALE.*CURSOR/i.test(error.code ?? "")) {
          cursor = null;
          update({ items: [], nextCursor: null, notice: "目录已更新，已重新加载。" });
          continue;
        }
        if (parentId && error instanceof ApiError && [403, 404].includes(error.status) && fallback.length) {
          parentId = fallback.shift()!;
          recovered = true;
          cursor = null;
          continue;
        }
        update({ loading: false, error: error instanceof Error ? error.message : "加载失败", nextCursor: null, canWrite: false, canCreateChild: false });
        return;
      }
    }
  }, [update]);

  const refresh = useCallback(() => fetchItems(false), [fetchItems]);
  const loadMore = useCallback(() => fetchItems(true), [fetchItems]);
  useEffect(() => {
    void refresh();
    return () => { requestId.current++; };
  }, [state.currentParentId, state.searchQuery, state.sortField, state.sortOrder, state.recent, connected, refresh]);

  const previousVersion = useRef(directoryVersion);
  useEffect(() => {
    if (previousVersion.current === directoryVersion) return;
    previousVersion.current = directoryVersion;
    if (!connected) return;
    const timer = window.setTimeout(() => { void refresh(); }, 100);
    return () => window.clearTimeout(timer);
  }, [directoryVersion, connected, refresh]);

  const previousKey = useRef(preferenceKey);
  useEffect(() => {
    if (previousKey.current === preferenceKey) return;
    previousKey.current = preferenceKey;
    requestId.current++;
    update(readPreferences(preferenceKey));
  }, [preferenceKey, update]);
  useEffect(() => {
    if (!preferenceKey) return;
    try { localStorage.setItem(preferenceKey, JSON.stringify({ viewMode: state.viewMode, sortField: state.sortField, sortOrder: state.sortOrder })); }
    catch { /* preferences are optional when storage is unavailable */ }
  }, [preferenceKey, state.viewMode, state.sortField, state.sortOrder]);

  const changeQuery = useCallback((patch: Partial<FileBrowserState>) => {
    requestId.current++; // invalidate synchronously, before React's next effect
    update({ items: [], total: 0, nextCursor: null, selectedIds: new Set(), error: null, notice: null, loading: true, hasLoaded: false, canRead: false, canWrite: false, canCreateChild: false, ...patch });
  }, [update]);
  const navigateTo = useCallback((target: string | null) => {
    const parentId = target ?? "";
    const s = current.current;
    if (parentId === s.currentParentId && !s.recent && !s.searchQuery) return;
    const sameParent = parentId === s.currentParentId;
    const history = sameParent ? s.history : [...s.history.slice(0, s.historyIndex + 1), parentId];
    changeQuery({ currentParentId: parentId, recent: false, searchQuery: "", ancestors: paths.current.get(parentId) ?? [], history, historyIndex: sameParent ? s.historyIndex : history.length - 1 });
  }, [changeQuery]);
  const travel = useCallback((direction: number) => {
    const s = current.current;
    const index = s.historyIndex + direction;
    if (index < 0 || index >= s.history.length) return;
    const parentId = s.history[index];
    changeQuery({ currentParentId: parentId, historyIndex: index, recent: false, searchQuery: "", ancestors: paths.current.get(parentId) ?? [] });
  }, [changeQuery]);
  const goUp = useCallback(() => {
    const s = current.current;
    const index = s.ancestors.findIndex(a => a.id === s.currentParentId);
    navigateTo(index > 0 ? s.ancestors[index - 1].id : "");
  }, [navigateTo]);
  const setSort = useCallback((field: SortField, order?: SortOrder) => {
    const s = current.current;
    const sortOrder = order ?? (s.sortField === field && s.sortOrder === "asc" ? "desc" : "asc");
    if (s.sortField !== field || s.sortOrder !== sortOrder) changeQuery({ sortField: field, sortOrder });
  }, [changeQuery]);
  const setSearch = useCallback((searchQuery: string) => {
    if (searchQuery !== current.current.searchQuery) changeQuery({ searchQuery });
  }, [changeQuery]);
  const setRecent = useCallback((recent: boolean) => {
    const s = current.current;
    if (recent === s.recent) return;
    const history = s.currentParentId ? [...s.history.slice(0, s.historyIndex + 1), ""] : s.history;
    changeQuery({ recent, currentParentId: "", searchQuery: "", ancestors: [], history, historyIndex: s.currentParentId ? history.length - 1 : s.historyIndex });
  }, [changeQuery]);

  return {
    ...state, connected, navigateTo, goUp, goBack: () => travel(-1), goForward: () => travel(1),
    goToAncestor: (index: number) => navigateTo(index === 0 ? "" : current.current.ancestors[index - 1]?.id ?? ""),
    select: (id: string, toggle = false, range = false) => {
      const s = current.current;
      update({ selectedIds: selectFileRange(s.items.map(item => item.id), s.selectedIds, id, selectionAnchor.current, toggle, range) });
      if (!range) selectionAnchor.current = id;
    },
    selectAll: () => update({ selectedIds: new Set(current.current.items.map(item => item.id)) }),
    clearSelection: () => update({ selectedIds: new Set() }),
    setViewMode: (viewMode: ViewMode) => update({ viewMode }),
    setSort, setSearch, setRecent, refresh, loadMore,
    getCurrent: () => current.current,
    isOnline: () => online.current,
  };
}
