/**
 * dock-layout.ts – Dock grouping / dedup / sorting pure functions
 *
 * Layout sections (left to right for bottom, top to bottom for sides):
 *   1. pinnedSection  – user-pinned apps in user order
 *   2. runningSection – running apps not pinned
 *   3. recentSection  – up to maxRecentApps recently-used, not pinned/running
 *   4. (divider)
 *   5. minimizedSection – minimized windows (separate or absorbed into icons)
 *
 * Drag-out only unpins; it never uninstalls plugins.
 * Running apps remain visible even after unpinning.
 */

export type DockLayoutApp = {
  id: string;
  name: string;
};

export type DockLayoutInput = {
  /** User-pinned app IDs in user-defined order. */
  pinnedIds: readonly string[];
  /** Currently running app IDs (session alive). */
  runningAppIds: readonly string[];
  /** Recently activated app IDs (most-recent-first). */
  recentAppIds: readonly string[];
  /** App IDs that have minimized windows. */
  minimizedWindowAppIds: readonly string[];
  /** All known app definitions (catalog). */
  apps: readonly DockLayoutApp[];
  /** Maximum recent apps to show (default 3). */
  maxRecentApps: number;
  /** When true, minimized windows are absorbed into their app icon. */
  minimizeIntoAppIcon: boolean;
};

export type DockLayoutResult = {
  pinnedSection: string[];
  runningSection: string[];
  recentSection: string[];
  minimizedSection: string[];
  showDivider: boolean;
};

export function computeDockLayout(input: DockLayoutInput): DockLayoutResult {
  const catalogIds = new Set(input.apps.map((app) => app.id));

  // ── Pinned section: user order, filtered to known apps ─────────────
  const pinnedSection = input.pinnedIds.filter((id) => catalogIds.has(id));
  const pinnedSet = new Set(pinnedSection);

  // ── Running section: running apps not in pinned, in running order ──
  const runningSet = new Set(input.runningAppIds);
  const runningSection = input.runningAppIds.filter(
    (id) => catalogIds.has(id) && !pinnedSet.has(id),
  );
  const runningAndPinned = new Set([...pinnedSet, ...runningSection]);

  // ── Recent section: dedup, exclude pinned+running, limit to max ────
  const recentSection: string[] = [];
  const recentSeen = new Set<string>();
  for (const id of input.recentAppIds) {
    if (recentSection.length >= input.maxRecentApps) break;
    if (runningAndPinned.has(id)) continue;
    if (!catalogIds.has(id)) continue;
    if (recentSeen.has(id)) continue;
    recentSeen.add(id);
    recentSection.push(id);
  }

  // ── Minimized section ──────────────────────────────────────────────
  const minimizedSection = input.minimizeIntoAppIcon
    ? []
    : input.minimizedWindowAppIds.filter(
        (id) => catalogIds.has(id) && !pinnedSet.has(id),
      );

  // ── Divider: shown when there are special items or minimized apps ──
  const showDivider =
    minimizedSection.length > 0 ||
    recentSection.length > 0 ||
    // Always show divider to separate apps from Downloads/Trash
    true;

  return {
    pinnedSection,
    runningSection,
    recentSection,
    minimizedSection,
    showDivider,
  };
}
