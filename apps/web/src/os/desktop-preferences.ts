export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type DesktopPreferencesIdentity = {
  gateway: string;
  workspaceId: string;
  userId: string;
};

export type DesktopPreferencesV1 = {
  version: 1;
  dock: {
    size: number;
    magnification: boolean;
    magnificationScale: number;
    position: "bottom" | "left" | "right";
    minimizeEffect: "genie" | "scale";
    minimizeIntoAppIcon: boolean;
    animateOpening: boolean;
    autoHide: boolean;
    showRunningIndicators: boolean;
    showRecentApps: boolean;
  };
  window: {
    doubleClick: "fill" | "zoom" | "minimize" | "none";
    tileByDragging: boolean;
    optionAcceleratesTiling: boolean;
    tileMargins: boolean;
    topEdgeOpensOverview: boolean;
  };
  missionControl: {
    switchToAppSpace: boolean;
    sortSpacesByRecentUse: boolean;
  };
};

export type DesktopPreferences = DesktopPreferencesV1;

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferencesV1 = {
  version: 1,
  dock: {
    size: 48,
    magnification: true,
    magnificationScale: 1.6,
    position: "bottom",
    minimizeEffect: "genie",
    minimizeIntoAppIcon: false,
    animateOpening: true,
    autoHide: false,
    showRunningIndicators: true,
    showRecentApps: true,
  },
  window: {
    doubleClick: "fill",
    tileByDragging: true,
    optionAcceleratesTiling: false,
    tileMargins: true,
    topEdgeOpensOverview: false,
  },
  missionControl: {
    switchToAppSpace: true,
    sortSpacesByRecentUse: true,
  },
};

const memoryPreferences = new Map<string, string>();
const memoryAuthoritativeKeys = new Set<string>();

function defaults(): DesktopPreferencesV1 {
  return {
    ...DEFAULT_DESKTOP_PREFERENCES,
    dock: { ...DEFAULT_DESKTOP_PREFERENCES.dock },
    window: { ...DEFAULT_DESKTOP_PREFERENCES.window },
    missionControl: { ...DEFAULT_DESKTOP_PREFERENCES.missionControl },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function section(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const candidate = value[key];
  return candidate === undefined ? {} : isRecord(candidate) ? candidate : null;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "boolean";
}

function optionalEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): boolean {
  return (
    value[key] === undefined ||
    (typeof value[key] === "string" && allowed.includes(value[key]))
  );
}

function optionalNumber(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): boolean {
  const candidate = value[key];
  return (
    candidate === undefined ||
    (typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= minimum &&
      candidate <= maximum)
  );
}

export function desktopPreferencesKey(
  identity: DesktopPreferencesIdentity,
): string {
  return `linkos.desktop-preferences:${JSON.stringify([
    identity.gateway,
    identity.workspaceId,
    identity.userId,
  ])}`;
}

export function validateDesktopPreferences(
  value: unknown,
): DesktopPreferencesV1 | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const dock = section(value, "dock");
  const window = section(value, "window");
  const missionControl = section(value, "missionControl");
  if (!dock || !window || !missionControl) return null;

  if (
    !optionalNumber(dock, "size", 24, 80) ||
    !optionalBoolean(dock, "magnification") ||
    !optionalNumber(dock, "magnificationScale", 1, 2) ||
    !optionalEnum(dock, "position", ["bottom", "left", "right"]) ||
    !optionalEnum(dock, "minimizeEffect", ["genie", "scale"]) ||
    !optionalBoolean(dock, "minimizeIntoAppIcon") ||
    !optionalBoolean(dock, "animateOpening") ||
    !optionalBoolean(dock, "autoHide") ||
    !optionalBoolean(dock, "showRunningIndicators") ||
    !optionalBoolean(dock, "showRecentApps") ||
    !optionalEnum(window, "doubleClick", [
      "fill",
      "zoom",
      "minimize",
      "none",
    ]) ||
    !optionalBoolean(window, "tileByDragging") ||
    !optionalBoolean(window, "optionAcceleratesTiling") ||
    !optionalBoolean(window, "tileMargins") ||
    !optionalBoolean(window, "topEdgeOpensOverview") ||
    !optionalBoolean(missionControl, "switchToAppSpace") ||
    !optionalBoolean(missionControl, "sortSpacesByRecentUse")
  ) {
    return null;
  }

  const result = defaults();
  return {
    version: 1,
    dock: {
      size: (dock.size as number | undefined) ?? result.dock.size,
      magnification:
        (dock.magnification as boolean | undefined) ??
        result.dock.magnification,
      magnificationScale:
        (dock.magnificationScale as number | undefined) ??
        result.dock.magnificationScale,
      position:
        (dock.position as
          DesktopPreferencesV1["dock"]["position"] | undefined) ??
        result.dock.position,
      minimizeEffect:
        (dock.minimizeEffect as
          DesktopPreferencesV1["dock"]["minimizeEffect"] | undefined) ??
        result.dock.minimizeEffect,
      minimizeIntoAppIcon:
        (dock.minimizeIntoAppIcon as boolean | undefined) ??
        result.dock.minimizeIntoAppIcon,
      animateOpening:
        (dock.animateOpening as boolean | undefined) ??
        result.dock.animateOpening,
      autoHide: (dock.autoHide as boolean | undefined) ?? result.dock.autoHide,
      showRunningIndicators:
        (dock.showRunningIndicators as boolean | undefined) ??
        result.dock.showRunningIndicators,
      showRecentApps:
        (dock.showRecentApps as boolean | undefined) ??
        result.dock.showRecentApps,
    },
    window: {
      doubleClick:
        (window.doubleClick as
          DesktopPreferencesV1["window"]["doubleClick"] | undefined) ??
        result.window.doubleClick,
      tileByDragging:
        (window.tileByDragging as boolean | undefined) ??
        result.window.tileByDragging,
      optionAcceleratesTiling:
        (window.optionAcceleratesTiling as boolean | undefined) ??
        result.window.optionAcceleratesTiling,
      tileMargins:
        (window.tileMargins as boolean | undefined) ??
        result.window.tileMargins,
      topEdgeOpensOverview:
        (window.topEdgeOpensOverview as boolean | undefined) ??
        result.window.topEdgeOpensOverview,
    },
    missionControl: {
      switchToAppSpace:
        (missionControl.switchToAppSpace as boolean | undefined) ??
        result.missionControl.switchToAppSpace,
      sortSpacesByRecentUse:
        (missionControl.sortSpacesByRecentUse as boolean | undefined) ??
        result.missionControl.sortSpacesByRecentUse,
    },
  };
}

export function parseDesktopPreferences(
  raw: string | null,
): DesktopPreferencesV1 {
  if (raw === null) return defaults();
  try {
    return validateDesktopPreferences(JSON.parse(raw)) ?? defaults();
  } catch {
    return defaults();
  }
}

export type DesktopPreferencesUpdate =
  | DesktopPreferencesV1
  | ((preferences: DesktopPreferencesV1) => DesktopPreferencesV1);

export function applyDesktopPreferencesUpdate(
  current: DesktopPreferencesV1,
  update: DesktopPreferencesUpdate,
): DesktopPreferencesV1 {
  const candidate = typeof update === "function" ? update(current) : update;
  return validateDesktopPreferences(candidate) ?? current;
}

export function readDesktopPreferences(
  storage: StorageLike | null | undefined,
  key: string,
): DesktopPreferencesV1 {
  let raw: string | null = memoryAuthoritativeKeys.has(key)
    ? (memoryPreferences.get(key) ?? null)
    : null;
  if (!memoryAuthoritativeKeys.has(key)) {
    try {
      raw = storage?.getItem(key) ?? null;
    } catch {
      raw = memoryPreferences.get(key) ?? null;
    }
    if (raw === null) raw = memoryPreferences.get(key) ?? null;
  }
  return parseDesktopPreferences(raw);
}

export function writeDesktopPreferences(
  storage: StorageLike | null | undefined,
  key: string,
  preferences: DesktopPreferencesV1,
): boolean {
  const validated = validateDesktopPreferences(preferences);
  if (!validated) return false;
  const raw = JSON.stringify(validated);
  memoryPreferences.set(key, raw);
  if (!storage) {
    memoryAuthoritativeKeys.add(key);
    return true;
  }
  try {
    storage.setItem(key, raw);
    memoryAuthoritativeKeys.delete(key);
  } catch {
    memoryAuthoritativeKeys.add(key);
  }
  return true;
}

export type DesktopPreferencesStorageController = {
  hydrate: (identity: DesktopPreferencesIdentity) => {
    key: string;
    preferences: DesktopPreferencesV1;
  };
  write: (key: string, preferences: DesktopPreferencesV1) => boolean;
  acceptStorage: (
    key: string | null,
    raw: string | null,
  ) => DesktopPreferencesV1 | null;
  getCurrentKey: () => string | null;
};

export function createDesktopPreferencesStorageController(
  storage: StorageLike | null | undefined,
): DesktopPreferencesStorageController {
  let currentKey: string | null = null;
  return {
    hydrate(identity) {
      const key = desktopPreferencesKey(identity);
      const preferences = readDesktopPreferences(storage, key);
      currentKey = key;
      return { key, preferences };
    },
    write(key, preferences) {
      if (key !== currentKey) return false;
      return writeDesktopPreferences(storage, key, preferences);
    },
    acceptStorage(key, raw) {
      if (
        key === null ||
        key !== currentKey ||
        raw === null ||
        memoryAuthoritativeKeys.has(key)
      ) {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      const preferences = validateDesktopPreferences(parsed);
      if (!preferences) return null;
      memoryPreferences.set(key, JSON.stringify(preferences));
      return preferences;
    },
    getCurrentKey: () => currentKey,
  };
}
