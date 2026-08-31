import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

export type AppId =
  | "system"
  | "files"
  | "chat"
  | "code"
  | "tasks"
  | "plugins"
  | "settings";

export type AppDefinition = {
  id: AppId;
  name: string;
  icon: LucideIcon;
  gradient: string;
  component: ComponentType;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
};

export type WindowState = {
  id: string;
  appId: AppId;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minimized: boolean;
  maximized: boolean;
  z: number;
};
