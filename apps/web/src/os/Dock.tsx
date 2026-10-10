import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Download, LogOut, Minimize2, Pin, Trash2, X } from "lucide-react";
import { useAppRegistry } from "./app-registry";
import { AppIcon } from "./AppIcon";
import { useWindowManager } from "./window-manager";
import { useSession } from "../lib/session";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { requestFileLocation } from "../lib/file-intent";
import { getGatewayBase } from "../lib/api";
import type { DynamicAppId } from "./types";
import { apps as defaultApps } from "./apps";

export function Dock({ connected }: { connected: boolean }) {
  const { windows, open, focus, close, minimize } = useWindowManager();
  const { profile, exit } = useSession();
  const { open: openMenu } = useContextMenu();
  const { apps, commands, getApp } = useAppRegistry();
  const key = `linkos.dock:${JSON.stringify([getGatewayBase(), profile.workspaceId, profile.userId])}`;
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      if (Array.isArray(stored))
        return [
          ...new Set(
            stored.filter((id): id is string => typeof id === "string"),
          ),
        ];
    } catch {
      /* defaults */
    }
    return defaultApps.map((app) => app.id);
  });
  const knownApps = useRef(new Set(defaultApps.map((app) => app.id as string)));
  useEffect(() => {
    const added = apps.filter((app) => !knownApps.current.has(app.id));
    added.forEach((app) => knownApps.current.add(app.id));
    if (added.length)
      setOrder((current) => [...current, ...added.map((app) => app.id)]);
  }, [apps]);
  const [launching, setLaunching] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const drag = useRef<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(order));
    } catch {
      /* preferences are optional */
    }
  }, [key, order]);
  useEffect(() => {
    if (!launching) return;
    const timer = setTimeout(() => setLaunching(null), 600);
    return () => clearTimeout(timer);
  }, [launching]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const reset = () => {
    cancelAnimationFrame(frame.current);
    surface.current
      ?.querySelectorAll<HTMLElement>(".dock-slot")
      .forEach((el) => {
        el.style.setProperty("--dock-scale", "1");
        el.style.setProperty("--dock-shift", "0px");
      });
    surface.current?.style.setProperty("--dock-bg-scale", "1");
  };
  const magnify = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== "mouse" ||
      window.matchMedia("(prefers-reduced-motion: reduce), (max-width: 767px)")
        .matches ||
      drag.current
    )
      return;
    const x = event.clientX;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const root = surface.current;
      if (!root) return;
      const left = root.getBoundingClientRect().left;
      const slots = [...root.querySelectorAll<HTMLElement>(".dock-slot")];
      const scales = slots.map(
        (el) =>
          1 +
          0.58 *
            Math.max(
              0,
              1 -
                Math.abs(x - (left + el.offsetLeft + el.offsetWidth / 2)) / 125,
            ) **
              2,
      );
      const extra = scales.map(
        (scale, i) => slots[i].offsetWidth * (scale - 1),
      );
      const total = extra.reduce((sum, value) => sum + value, 0);
      let offset = -total / 2;
      slots.forEach((el, i) => {
        el.style.setProperty("--dock-scale", String(scales[i]));
        el.style.setProperty("--dock-shift", `${offset + extra[i] / 2}px`);
        offset += extra[i];
      });
      root.style.setProperty(
        "--dock-bg-scale",
        String(1 + total / root.offsetWidth),
      );
    });
  };
  const ordered = [
    ...order.flatMap((id) => apps.filter((app) => app.id === id)),
    ...apps.filter(
      (app) =>
        !order.includes(app.id) && windows.some((win) => win.appId === app.id),
    ),
  ];
  const menu = (id: DynamicAppId): ContextMenuItem[] => {
    const win = windows.find((item) => item.appId === id);
    return [
      ...commands
        .filter((command) => command.id.startsWith(`${id}:`))
        .map((command) => ({
          id: command.id,
          label: command.title,
          onClick: command.run,
        })),
      {
        id: "open",
        label: win ? "显示窗口" : "打开",
        onClick: () => (win ? focus(win.id) : open(id)),
      },
      ...(win
        ? [
            {
              id: "minimize",
              label: "最小化",
              icon: <Minimize2 size={14} />,
              disabled: win.minimized,
              onClick: () => minimize(win.id),
            },
          ]
        : []),
      {
        id: "pin",
        label: order.includes(id) ? "从 Dock 移除" : "保留在 Dock",
        icon: <Pin size={14} />,
        onClick: () =>
          setOrder((current) =>
            current.includes(id)
              ? current.filter((item) => item !== id)
              : [...current, id],
          ),
      },
      ...(win
        ? [
            {
              id: "close",
              label: "退出应用",
              icon: <X size={14} />,
              onClick: () => close(win.id),
            },
          ]
        : []),
    ];
  };
  const location = (target: "downloads" | "trash") => {
    if (!apps.some((app) => app.id === "files")) return;
    requestFileLocation(target);
    open("files");
  };
  return (
    <div className="desktop-dock-wrap">
      <div
        ref={surface}
        className="desktop-dock"
        role="toolbar"
        aria-label="应用程序 Dock"
        onPointerMove={magnify}
        onPointerLeave={reset}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ":scope > button",
            ),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          event.preventDefault();
          reset();
          buttons[next]?.focus();
        }}
      >
        <span
          className={`dock-connection ${connected ? "online" : ""}`}
          role="status"
          aria-label={connected ? "已连接工作区" : "连接已断开"}
        />
        {ordered.map((app) => {
          const win = windows.find((item) => item.appId === app.id);
          return (
            <button
              key={app.id}
              data-dock-app={app.id}
              className={`dock-slot ${launching === app.id ? "is-launching" : ""}`}
              aria-label={app.name}
              aria-pressed={!!win && !win.minimized}
              draggable
              onDragStart={(event) => {
                drag.current = app.id;
                reset();
                event.dataTransfer.setData("application/x-linkos-dock", app.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                drag.current = null;
                reset();
              }}
              onDragOver={(event) => {
                if (drag.current) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const source = drag.current;
                if (!source || source === app.id) return;
                setOrder((current) => {
                  const next = current.filter((id) => id !== source);
                  next.splice(Math.max(0, next.indexOf(app.id)), 0, source);
                  return next;
                });
                drag.current = null;
              }}
              onClick={() => {
                if (win) focus(win.id);
                else {
                  setLaunching(app.id);
                  open(app.id);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                reset();
                openMenu(
                  event.clientX,
                  event.clientY,
                  menu(app.id),
                  event.currentTarget,
                );
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "ContextMenu" ||
                  (event.shiftKey && event.key === "F10")
                ) {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  openMenu(
                    rect.left,
                    rect.top,
                    menu(app.id),
                    event.currentTarget,
                  );
                }
              }}
            >
              <span className="dock-visual">
                <AppIcon app={app} size={44} />
                <span className="dock-tooltip">
                  {app.name}
                  {win?.minimized ? " · 已最小化" : ""}
                </span>
              </span>
              <span className={`dock-running ${win ? "is-running" : ""}`} />
            </button>
          );
        })}
        <span className="dock-divider" />
        {windows
          .filter((win) => win.minimized && getApp(win.appId))
          .map((win) => (
            <button
              key={win.id}
              className="dock-slot dock-window"
              aria-label={`还原 ${win.title}`}
              onClick={() => focus(win.id)}
            >
              <span className="dock-visual">
                <span className="dock-mini-window">
                  <span />
                  <AppIcon app={getApp(win.appId)!} size={24} />
                </span>
                <span className="dock-tooltip">{win.title}</span>
              </span>
            </button>
          ))}
        <button
          className="dock-slot"
          aria-label="打开 Downloads"
          onClick={() => location("downloads")}
        >
          <span className="dock-visual dock-special dock-downloads">
            <Download size={26} />
            <span className="dock-tooltip">Downloads</span>
          </span>
        </button>
        <button
          className="dock-slot"
          aria-label="打开废纸篓"
          onClick={() => location("trash")}
        >
          <span className="dock-visual dock-special dock-trash">
            <Trash2 size={25} />
            <span className="dock-tooltip">废纸篓</span>
          </span>
        </button>
        <button
          className="dock-exit"
          aria-label="退出登录"
          title={`退出登录（${profile.displayName}）`}
          onClick={exit}
        >
          <LogOut size={15} />
        </button>
      </div>
    </div>
  );
}
