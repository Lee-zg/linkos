import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

export type AppId =
  | "system"
  | "files"
  | "chat"
  | "code"
  | "tasks"
  | "plugins"
  | "settings"
  | "admin";
export type DynamicAppId = AppId | `plugin:${string}`;

export type AppDefinition = {
  id: DynamicAppId;
  name: string;
  icon: LucideIcon;
  gradient: string;
  component: ComponentType;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
};

export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DesktopPlacement =
  | "normal"
  | "fill"
  | "zoom"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type WindowState = Rect & {
  id: string;
  appId: DynamicAppId;
  title: string;
  minimized: boolean;
  maximized: boolean;
  z: number;
};

export type ManagedWindow = Omit<WindowState, "maximized"> & {
  spaceId: string;
  placement: DesktopPlacement;
  restoreRect: Rect | null;
};

export type DesktopSpace =
  | { id: "desktop"; type: "desktop"; lastActiveId: string | null }
  | { id: string; type: "fullscreen"; windowId: string }
  | {
      id: string;
      type: "split";
      windowIds: readonly [string, string];
      ratio: number;
    };

export type DesktopState = {
  windows: ManagedWindow[];
  runningApps: DynamicAppId[];
  recentApps: DynamicAppId[];
  spaces: DesktopSpace[];
  currentSpaceId: string;
  activeId: string | null;
  overviewReturn: { spaceId: string; activeId: string | null } | null;
  transitionEpoch: number;
};
