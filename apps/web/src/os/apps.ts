import {
  Activity,
  Code2,
  Files,
  LayoutGrid,
  MessageSquare,
  Settings,
  Terminal,
} from "lucide-react";
import type { AppDefinition, AppId } from "./types";
import { SystemApp } from "../apps/SystemApp";
import { FilesApp } from "../apps/FilesApp";
import { ChatApp } from "../apps/ChatApp";
import { CodeApp } from "../apps/CodeApp";
import { TasksApp } from "../apps/TasksApp";
import { PluginsApp } from "../apps/PluginsApp";
import { SettingsApp } from "../apps/SettingsApp";

export const apps: AppDefinition[] = [
  {
    id: "system",
    name: "系统状态",
    icon: Activity,
    gradient: "linear-gradient(135deg, #38bdf8, #2563eb)",
    component: SystemApp,
    defaultSize: { w: 880, h: 620 },
    minSize: { w: 520, h: 420 },
  },
  {
    id: "files",
    name: "文件",
    icon: Files,
    gradient: "linear-gradient(135deg, #fbbf24, #ea580c)",
    component: FilesApp,
    defaultSize: { w: 800, h: 580 },
    minSize: { w: 480, h: 380 },
  },
  {
    id: "chat",
    name: "聊天",
    icon: MessageSquare,
    gradient: "linear-gradient(135deg, #4ade80, #16a34a)",
    component: ChatApp,
    defaultSize: { w: 860, h: 620 },
    minSize: { w: 480, h: 420 },
  },
  {
    id: "code",
    name: "代码",
    icon: Code2,
    gradient: "linear-gradient(135deg, #818cf8, #4f46e5)",
    component: CodeApp,
    defaultSize: { w: 960, h: 640 },
    minSize: { w: 560, h: 420 },
  },
  {
    id: "tasks",
    name: "任务",
    icon: Terminal,
    gradient: "linear-gradient(135deg, #c084fc, #9333ea)",
    component: TasksApp,
    defaultSize: { w: 820, h: 600 },
    minSize: { w: 520, h: 400 },
  },
  {
    id: "plugins",
    name: "应用管理",
    icon: LayoutGrid,
    gradient: "linear-gradient(135deg, #2dd4bf, #0d9488)",
    component: PluginsApp,
    defaultSize: { w: 780, h: 580 },
    minSize: { w: 480, h: 400 },
  },
  {
    id: "settings",
    name: "设置",
    icon: Settings,
    gradient: "linear-gradient(135deg, #94a3b8, #475569)",
    component: SettingsApp,
    defaultSize: { w: 640, h: 520 },
    minSize: { w: 420, h: 360 },
  },
];

const appIndex = new Map(apps.map((app) => [app.id, app]));

export function getApp(id: AppId): AppDefinition {
  const app = appIndex.get(id);
  if (!app) throw new Error(`Unknown app: ${id}`);
  return app;
}
