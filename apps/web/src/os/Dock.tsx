import { LogOut, X, Minimize2 } from "lucide-react";
import { visibleApps } from "./apps";
import { AppIcon } from "./AppIcon";
import { useWindowManager } from "./window-manager";
import { useSession } from "../lib/session";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { AppId } from "./types";

export function Dock({ connected }: { connected: boolean }) {
  const { windows, open, focus, close, minimize } = useWindowManager();
  const { profile, exit } = useSession();
  const { open: openMenu } = useContextMenu();

  const createAppMenu = (appId: AppId, win: typeof windows[0] | undefined): ContextMenuItem[] => {
    if (!win) {
      return [
        {
          id: "open",
          label: "打开",
          onClick: () => open(appId),
        },
      ];
    }

    return [
      {
        id: "focus",
        label: "显示窗口",
        onClick: () => focus(win.id),
      },
      {
        id: "minimize",
        label: "最小化",
        icon: <Minimize2 size={14} />,
        onClick: () => minimize(win.id),
      },
      {
        id: "close",
        label: "关闭",
        icon: <X size={14} />,
        onClick: () => close(win.id),
      },
    ];
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-[9000] flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full items-end gap-1 overflow-x-auto rounded-2xl border border-border/50 bg-popover/60 px-3 py-2 shadow-lg backdrop-blur-xl scrollbar-none">
        <span
          className="mr-1 mb-[7px] h-1.5 w-1.5 shrink-0 self-center rounded-full"
          style={{ background: connected ? "#22c55e" : "#a3a3a3" }}
          title={connected ? "已连接工作区" : "连接已断开"}
          role="status"
          aria-label={connected ? "已连接工作区" : "连接已断开"}
        />
        {visibleApps(profile.role).map((app) => {
          const win = windows.find((w) => w.appId === app.id);
          const appMenu = createAppMenu(app.id, win);
          return (
            <button
              key={app.id}
              className="group flex cursor-pointer flex-col items-center gap-0.5 rounded-lg border-none bg-transparent p-1 transition-transform duration-150 hover:-translate-y-1 hover:scale-110 motion-reduce:hover:translate-y-0 motion-reduce:hover:scale-100"
              aria-label={app.name}
              title={app.name}
              onClick={() => {
                if (!win) return open(app.id);
                focus(win.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openMenu(e.clientX, e.clientY, appMenu, e.currentTarget);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(rect.left, rect.top, appMenu, event.currentTarget);
              }}
            >
              <AppIcon app={app} size={40} />
              <span
                className={`h-1 w-1 rounded-full bg-foreground/60 ${
                  win ? "opacity-100" : "opacity-0"
                }`}
              />
            </button>
          );
        })}
        <span className="mx-1 mb-[7px] h-6 w-px shrink-0 self-center bg-border" />
        <button
          className="mb-[7px] flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center self-center rounded-lg border-none bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
          title={`退出登录（${profile.displayName}）`}
          aria-label="退出登录"
          onClick={exit}
        >
          <LogOut size={15} />
        </button>
      </div>
    </div>
  );
}
