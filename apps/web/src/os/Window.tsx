import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Minus, Square, X, Maximize2, Minimize2 } from "lucide-react";
import type { WindowState } from "./types";
import { getApp } from "./apps";
import { useWindowManager } from "./window-manager";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

export function Window({ win }: { win: WindowState }) {
  const { close, focus, minimize, toggleMaximize, move, resize } =
    useWindowManager();
  const { open: openMenu } = useContextMenu();
  const frameRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number>();
  const isMobile = useIsMobile();
  const [appeared, setAppeared] = useState(false);
  const [closing, setClosing] = useState(false);
  const app = getApp(win.appId);
  const Content = app.component;

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    if (win.minimized) {
      const target = document.querySelector<HTMLElement>(`[data-dock-app="${win.appId}"]`)?.getBoundingClientRect();
      const x = win.maximized || isMobile ? window.innerWidth / 2 : win.x + win.w / 2;
      const y = win.maximized || isMobile ? (window.innerHeight - 88) / 2 : win.y + win.h / 2;
      frame.style.setProperty("--minimize-x", `${(target ? target.left + target.width / 2 : window.innerWidth / 2) - x}px`);
      frame.style.setProperty("--minimize-y", `${(target ? target.top + target.height / 2 : window.innerHeight - 40) - y}px`);
      frame.setAttribute("inert", "");
    } else frame.removeAttribute("inert");
  }, [win.minimized, win.appId, win.x, win.y, win.w, win.h, win.maximized, isMobile]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setAppeared(true));
    return () => {
      window.cancelAnimationFrame(frame);
      if (closeTimerRef.current !== undefined) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => close(win.id), 150);
  };

  const titleBarMenu: ContextMenuItem[] = [
    {
      id: "minimize",
      label: "最小化",
      icon: <Minimize2 size={14} />,
      onClick: () => minimize(win.id),
    },
    {
      id: "maximize",
      label: win.maximized ? "还原" : "最大化",
      icon: <Maximize2 size={14} />,
      onClick: () => toggleMaximize(win.id),
    },
    {
      id: "close",
      label: "关闭",
      icon: <X size={14} />,
      onClick: requestClose,
    },
  ];

  const handleTitleBarContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, titleBarMenu, e.currentTarget as HTMLElement);
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (win.maximized || isMobile) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const frame = frameRef.current;
    if (!frame) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    let dx = 0;
    let dy = 0;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      dx = moveEvent.clientX - startX;
      dy = moveEvent.clientY - startY;
      frame.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const onStop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onStop);
      window.removeEventListener("pointercancel", onStop);
      frame.style.transform = "";
      if (dx || dy) {
        const minVisible = 120;
        const maxX = Math.max(8, window.innerWidth - minVisible);
        const minX = Math.min(8, minVisible - win.w);
        const maxY = Math.max(8, window.innerHeight - win.h - 88);
        move(
          win.id,
          Math.min(Math.max(win.x + dx, minX), maxX),
          Math.min(Math.max(win.y + dy, 8), maxY),
        );
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onStop);
    window.addEventListener("pointercancel", onStop);
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || win.maximized || isMobile) return;
    const frame = frameRef.current;
    if (!frame) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    let w = win.w;
    let h = win.h;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const availableWidth = Math.max(
        app.minSize.w,
        window.innerWidth - win.x - 8,
      );
      const availableHeight = Math.max(
        app.minSize.h,
        window.innerHeight - win.y - 88,
      );
      w = Math.min(
        availableWidth,
        Math.max(app.minSize.w, win.w + moveEvent.clientX - startX),
      );
      h = Math.min(
        availableHeight,
        Math.max(app.minSize.h, win.h + moveEvent.clientY - startY),
      );
      frame.style.width = `${w}px`;
      frame.style.height = `${h}px`;
    };
    const onStop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onStop);
      window.removeEventListener("pointercancel", onStop);
      if (w !== win.w || h !== win.h) resize(win.id, w, h);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onStop);
    window.addEventListener("pointercancel", onStop);
  };

  const fullscreen = win.maximized || isMobile;
  const hidden = !appeared || win.minimized || closing;
  return (
    <div
      ref={frameRef}
      className={`desktop-window pointer-events-auto absolute flex flex-col overflow-hidden bg-background shadow-2xl transition-[opacity,transform] duration-150 motion-reduce:transition-none ${win.minimized ? "is-minimized" : ""} ${
        fullscreen
          ? "inset-x-0 top-0 bottom-[88px] rounded-none border-0"
          : "rounded-xl border"
      } ${hidden ? "pointer-events-none scale-[0.97] opacity-0" : "scale-100 opacity-100"}`}
      style={
        fullscreen
          ? { zIndex: win.z }
          : {
              left: win.x,
              top: win.y,
              width: win.w,
              height: win.h,
              zIndex: win.z,
            }
      }
      role="dialog"
      aria-hidden={win.minimized || undefined}
      aria-label={win.title}
      onPointerDown={() => !closing && focus(win.id)}
    >
      <div
        className="relative flex h-10 shrink-0 items-center border-b bg-muted/50 px-3"
        onPointerDown={startDrag}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          if (!isMobile) toggleMaximize(win.id);
        }}
        onContextMenu={handleTitleBarContextMenu}
        tabIndex={0}
        aria-label={`${win.title} 标题栏`}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu(rect.left, rect.bottom, titleBarMenu, event.currentTarget);
        }}
      >
        <div className="group flex items-center gap-0.5" aria-label="窗口控制">
          <button
            className="relative grid h-7 w-7 place-items-center rounded-md border-none bg-transparent p-0 text-black/60 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`关闭 ${win.title}`}
            onClick={requestClose}
            disabled={closing}
          >
            <span className="grid h-3 w-3 place-items-center rounded-full bg-[#ff5f57]">
              <X size={8} className="opacity-0 group-hover:opacity-100" />
            </span>
          </button>
          <button
            className="relative grid h-7 w-7 place-items-center rounded-md border-none bg-transparent p-0 text-black/60 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`最小化 ${win.title}`}
            onClick={() => minimize(win.id)}
            disabled={closing}
          >
            <span className="grid h-3 w-3 place-items-center rounded-full bg-[#febc2e]">
              <Minus size={8} className="opacity-0 group-hover:opacity-100" />
            </span>
          </button>
          <button
            className="relative grid h-7 w-7 place-items-center rounded-md border-none bg-transparent p-0 text-black/60 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`最大化 ${win.title}`}
            onClick={() => toggleMaximize(win.id)}
            disabled={closing}
          >
            <span className="grid h-3 w-3 place-items-center rounded-full bg-[#28c840]">
              <Square size={7} className="opacity-0 group-hover:opacity-100" />
            </span>
          </button>
        </div>
        <span className="pointer-events-none absolute left-1/2 max-w-[45%] -translate-x-1/2 truncate text-xs font-medium text-foreground/80">
          {win.title}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <Content />
      </div>
      {!fullscreen && (
        <div
          className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize"
          onPointerDown={startResize}
        />
      )}
    </div>
  );
}

export function WindowLayer() {
  const { windows } = useWindowManager();
  return (
    <div className="pointer-events-none fixed inset-0 isolate z-10">
      {windows.map((win) => (
        <Window key={win.id} win={win} />
      ))}
    </div>
  );
}
