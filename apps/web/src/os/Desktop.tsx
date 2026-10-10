import { useState } from "react";
import { Folder, Monitor, Settings } from "lucide-react";
import { useAppRegistry } from "./app-registry";
import { AppIcon } from "./AppIcon";
import { useWindowManager } from "./window-manager";
import { useSession } from "../lib/session";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";

export function Desktop() {
  const { windows, open, minimize, close, minimizeAll } = useWindowManager();
  const { profile } = useSession();
  const catalog = useAppRegistry();
  const [selected, setSelected] = useState<string | null>(null);
  const { open: openMenu } = useContextMenu();

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

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, desktopMenu, e.currentTarget);
  };

  return (
    <div
      className="wallpaper fixed inset-0 overflow-hidden"
      onPointerDown={() => setSelected(null)}
      onContextMenu={handleContextMenu}
    >
      <div className="desktop-icons relative z-[1] p-3">
        {catalog.apps.map((app) => (
          <button
            key={app.id}
            className={`flex w-[92px] cursor-pointer flex-col items-center gap-1.5 rounded-lg border-none bg-transparent px-1 py-2 select-none ${
              selected === app.id ? "bg-white/20" : "hover:bg-white/10"
            }`}
            aria-pressed={selected === app.id}
            onPointerDown={(event) => {
              event.stopPropagation();
              setSelected(app.id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelected(app.id);
              const win = windows.find((item) => item.appId === app.id);
              const items: ContextMenuItem[] = [
                {
                  id: "open",
                  label: win ? "显示窗口" : "打开",
                  onClick: () => open(app.id),
                },
              ];
              if (win)
                items.push(
                  {
                    id: "minimize",
                    label: "最小化",
                    onClick: () => minimize(win.id),
                  },
                  {
                    id: "close",
                    label: "关闭窗口",
                    onClick: () => close(win.id),
                  },
                );
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(
                event.clientX || rect.left,
                event.clientY || rect.bottom,
                items,
                event.currentTarget,
              );
            }}
            onDoubleClick={() => open(app.id)}
            onClick={() => {
              if (window.matchMedia("(max-width: 767px)").matches) open(app.id);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.dispatchEvent(
                  new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                  }),
                );
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open(app.id);
              }
            }}
          >
            <AppIcon app={app} size={56} />
            <span className="text-[11px] leading-tight text-white [text-shadow:0_0_1px_rgb(0_0_0),0_1px_2px_rgb(0_0_0/0.6)]">
              {app.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
