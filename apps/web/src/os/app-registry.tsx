import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Package } from "lucide-react";
import type { PluginRecord } from "@linkos/protocol";
import { apps as builtins } from "./apps";
import type { AppDefinition, DynamicAppId } from "./types";
import { listPlugins } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { useSession } from "../lib/session";
import { builtinAppIDs, isBuiltinPlugin } from "../lib/plugin-policy";
import { PluginFrame } from "../apps/PluginFrame";

type Command = { id: string; title: string; run: () => void };
type Catalog = {
  apps: AppDefinition[];
  plugins: PluginRecord[];
  loading: boolean;
  refreshing: boolean;
  error: string;
  refresh: () => Promise<void>;
  update: (plugin: PluginRecord) => void;
  getApp: (id: DynamicAppId) => AppDefinition | undefined;
  commands: Command[];
  registerCommand: (pluginId: string, command: Command) => () => void;
};
const Context = createContext<Catalog | null>(null);
const pluginComponents = new Map<string, AppDefinition["component"]>();
function pluginComponent(id: string) {
  let component = pluginComponents.get(id);
  if (!component) {
    component = function ExternalPluginWindow() {
      const { plugins } = useAppRegistry();
      const plugin = plugins.find((item) => item.id === id);
      return plugin?.status === "enabled" ? (
        <PluginFrame plugin={plugin} />
      ) : null;
    };
    pluginComponents.set(id, component);
  }
  return component;
}
export function AppRegistryProvider({ children }: { children: ReactNode }) {
  const { connected, lastEvent, resyncSeq } = useWorkspace();
  const { profile } = useSession();
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [loading, setLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState("");
  const [commands, setCommands] = useState<Command[]>([]);
  const generation = useRef(0),
    mounted = useRef(true);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setRefreshing(true);
    try {
      const result = await listPlugins();
      if (!mounted.current || request !== generation.current) return;
      setPlugins((current) =>
        JSON.stringify(current) === JSON.stringify(result.items)
          ? current
          : result.items,
      );
      setError("");
    } catch (err) {
      if (mounted.current && request === generation.current)
        setError(err instanceof Error ? err.message : "应用目录加载失败");
    } finally {
      if (mounted.current && request === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);
  useEffect(() => {
    if (lastEvent?.type === "plugin.updated" || resyncSeq) void refresh();
  }, [
    lastEvent?.type === "plugin.updated" ? lastEvent : null,
    resyncSeq,
    refresh,
  ]);
  useEffect(() => {
    if (connected) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [connected, refresh]);
  const update = useCallback((plugin: PluginRecord) => {
    generation.current++;
    setLoading(false);
    setRefreshing(false);
    setError("");
    setPlugins((items) =>
      [...items.filter((item) => item.id !== plugin.id), plugin].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
  }, []);
  const definitions = useMemo(() => {
    const enabled = new Set(
      plugins
        .filter((item) => item.status === "enabled")
        .map((item) => item.id),
    );
    const official = builtins.filter((app) => {
      if (
        app.id === "admin" &&
        profile.role !== "owner" &&
        profile.role !== "admin"
      )
        return false;
      const entry = Object.entries(builtinAppIDs).find(
        ([, id]) => id === app.id,
      );
      return !entry || enabled.has(entry[0]);
    });
    const external: AppDefinition[] = plugins
      .filter(
        (item) =>
          !isBuiltinPlugin(item.id) &&
          item.status === "enabled" &&
          item.source === "package",
      )
      .map((plugin) => ({
        id: `plugin:${plugin.id}`,
        name: plugin.name,
        icon: Package,
        gradient: "linear-gradient(135deg, #2dd4bf, #0d9488)",
        component: pluginComponent(plugin.id),
        defaultSize: { w: 800, h: 580 },
        minSize: { w: 480, h: 380 },
      }));
    return [...official, ...external];
  }, [plugins, profile.role]);
  const getApp = useCallback(
    (id: DynamicAppId) => definitions.find((item) => item.id === id),
    [definitions],
  );
  const registerCommand = useCallback((pluginId: string, command: Command) => {
    const id = `plugin:${pluginId}:${command.id}`;
    const item = { ...command, id };
    setCommands((current) => [
      ...current.filter((value) => value.id !== id),
      item,
    ]);
    return () =>
      setCommands((current) => current.filter((value) => value !== item));
  }, []);
  return (
    <Context.Provider
      value={{
        apps: definitions,
        plugins,
        loading,
        refreshing,
        error,
        refresh,
        update,
        getApp,
        commands,
        registerCommand,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAppRegistry() {
  const value = useContext(Context);
  if (!value) throw new Error("AppRegistryProvider is missing");
  return value;
}
