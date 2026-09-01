import { apps } from "./apps";
import { AppIcon } from "./AppIcon";
import { useWindowManager } from "./window-manager";

export function Dock({ connected }: { connected: boolean }) {
  const { windows, open, focus } = useWindowManager();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-[9000] flex justify-center px-3">
      <div className="pointer-events-auto flex items-end gap-1 rounded-2xl border border-border/50 bg-popover/60 px-3 py-2 shadow-lg backdrop-blur-xl">
        <span
          className="mr-1 mb-[7px] h-1.5 w-1.5 shrink-0 self-center rounded-full"
          style={{ background: connected ? "#22c55e" : "#a3a3a3" }}
          title={connected ? "已连接工作区" : "连接已断开"}
          role="status"
          aria-label={connected ? "已连接工作区" : "连接已断开"}
        />
        {apps.map((app) => {
          const win = windows.find((w) => w.appId === app.id);
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
      </div>
    </div>
  );
}
