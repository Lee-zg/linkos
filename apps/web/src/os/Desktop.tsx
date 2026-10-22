import { useRef, useState } from "react";
import { Folder, Monitor, Settings } from "lucide-react";
import { useAppRegistry } from "./app-registry";
import { AppIcon } from "./AppIcon";
import { useWindowManager } from "./window-manager";
import type { ContextMenuItem } from "./ContextMenu";
import { ContextMenuScope } from "./ContextMenuScope";
import { selectDesktopSurface } from "./window-surface-state";
import { useSurfaceInteractivity } from "./WindowSurface";
import type { DynamicAppId } from "./types";

export function Desktop() {
  const { windows, desktopState, open, focus, minimize, close, minimizeAll } =
    useWindowManager();
  const visible = selectDesktopSurface(desktopState);
  const root = useRef<HTMLDivElement | null>(null);
  useSurfaceInteractivity(root, visible);
  const catalog = useAppRegistry();
  const [selected, setSelected] = useState<string | null>(null);
  const launch = (id: DynamicAppId) => {
    const existing = windows.find((win) => win.appId === id);
    if (existing) focus(existing.id);
    else open(id);
  };

  const desktopMenu: ContextMenuItem[] = [
    {
      id: "open-files",
      label: "打开文件管理器",
      disabled: !catalog.getApp("files"),
      icon: <Folder size={14} />,
      onClick: () => open("files"),
    },
    {
      id: "show-desktop",
      label: "显示桌面",
      icon: <Monitor size={14} />,
      onClick: minimizeAll,
    },
    {
      id: "settings",
      label: "系统设置",
      icon: <Settings size={14} />,
      onClick: () => open("settings"),
    },
  ];

  return (
    <ContextMenuScope
      owner={{ kind: "desktop" }}
      active={visible}
      getMenu={() => desktopMenu}
    >
      {(ref) => (
        <div
          ref={(node) => {
            root.current = node;
            ref(node);
          }}
          className="wallpaper fixed inset-0 overflow-hidden"
          data-visible={visible}
          data-interactive={visible}
          data-space-id={desktopState.currentSpaceId}
          aria-hidden={!visible || undefined}
          tabIndex={-1}
          onPointerDown={() => setSelected(null)}
        >
          <div className="desktop-icons relative z-[1] p-3">
            {catalog.apps.map((app) => (
              <ContextMenuScope
                key={app.id}
                owner={{ kind: "shell", objectId: `desktop:${app.id}` }}
                active={visible}
                getMenu={() => {
                  setSelected(app.id);
                  const win = windows.find((item) => item.appId === app.id);
                  const items: ContextMenuItem[] = [
                    {
                      id: "open",
                      label: win ? "显示窗口" : "打开",
                      onClick: () => launch(app.id),
                    },
                  ];
                  if (win)
                    items.push(
                      {
                        id: "minimize",
                        label: "最小化",
                        disabled:
                          desktopState.windows.find(
                            (item) => item.id === win.id,
                          )?.spaceId !== "desktop",
                        onClick: () => minimize(win.id),
                      },
                      {
                        id: "close",
                        label: "关闭窗口",
                        onClick: () => close(win.id),
                      },
                    );
                  return items;
                }}
              >
                {(iconRef) => (
                  <button
                    ref={iconRef}
                    className={`flex w-[92px] cursor-pointer flex-col items-center gap-1.5 rounded-lg border-none bg-transparent px-1 py-2 select-none ${
                      selected === app.id ? "bg-white/20" : "hover:bg-white/10"
                    }`}
                    aria-pressed={selected === app.id}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setSelected(app.id);
                    }}
                    onDoubleClick={() => launch(app.id)}
                    onClick={() => {
                      if (window.matchMedia("(max-width: 767px)").matches)
                        launch(app.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        launch(app.id);
                      }
                    }}
                  >
                    <AppIcon app={app} size={56} />
                    <span className="text-[11px] leading-tight text-white [text-shadow:0_0_1px_rgb(0_0_0),0_1px_2px_rgb(0_0_0/0.6)]">
                      {app.name}
                    </span>
                  </button>
                )}
              </ContextMenuScope>
            ))}
          </div>
        </div>
      )}
    </ContextMenuScope>
  );
}
