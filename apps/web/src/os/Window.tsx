import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Minus, Square, X } from "lucide-react";
import type { WindowState } from "./types";
import { getApp } from "./apps";
import { useWindowManager } from "./window-manager";

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
  const frameRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const app = getApp(win.appId);
  const Content = app.component;

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (win.maximized || isMobile) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const frame = frameRef.current;
    if (!frame) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let dx = 0;
    let dy = 0;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      dx = moveEvent.clientX - startX;
      dy = moveEvent.clientY - startY;
      frame.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      frame.style.transform = "";
      if (dx || dy) {
        move(
          win.id,
          Math.min(Math.max(win.x + dx, -win.w + 80), window.innerWidth - 80),
          Math.min(Math.max(win.y + dy, 0), window.innerHeight - 48),
        );
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (win.maximized || isMobile) return;
    const frame = frameRef.current;
    if (!frame) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    let w = win.w;
    let h = win.h;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      w = Math.max(app.minSize.w, win.w + moveEvent.clientX - startX);
      h = Math.max(app.minSize.h, win.h + moveEvent.clientY - startY);
      frame.style.width = `${w}px`;
      frame.style.height = `${h}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (w !== win.w || h !== win.h) resize(win.id, w, h);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const fullscreen = win.maximized || isMobile;
  return (
    <div
      ref={frameRef}
      className={`pointer-events-auto absolute flex flex-col overflow-hidden bg-background shadow-2xl transition-[opacity] duration-150 ${
        fullscreen
          ? "inset-x-0 top-0 bottom-0 rounded-none border-0 md:bottom-[72px]"
          : "rounded-xl border"
      } ${win.minimized ? "pointer-events-none opacity-0" : "opacity-100"}`}
      style={
        fullscreen
          ? { zIndex: win.z }
          : { left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }
      }
      onPointerDown={() => focus(win.id)}
    >
      <div
        className="relative flex h-10 shrink-0 items-center border-b bg-muted/50 px-3"
        onPointerDown={startDrag}
        onDoubleClick={() => !isMobile && toggleMaximize(win.id)}
      >
        <div className="group flex items-center gap-2">
          <button
            className="grid h-3.5 w-3.5 place-items-center rounded-full border-none bg-[#ff5f57] p-0 text-black/60"
            aria-label={`关闭 ${win.title}`}
            onClick={() => close(win.id)}
          >
            <X size={9} className="opacity-0 group-hover:opacity-100" />
          </button>
          <button
            className="grid h-3.5 w-3.5 place-items-center rounded-full border-none bg-[#febc2e] p-0 text-black/60"
            aria-label={`最小化 ${win.title}`}
            onClick={() => minimize(win.id)}
          >
            <Minus size={9} className="opacity-0 group-hover:opacity-100" />
          </button>
          <button
            className="grid h-3.5 w-3.5 place-items-center rounded-full border-none bg-[#28c840] p-0 text-black/60"
            aria-label={`最大化 ${win.title}`}
            onClick={() => toggleMaximize(win.id)}
          >
            <Square size={7} className="opacity-0 group-hover:opacity-100" />
          </button>
        </div>
        <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-xs font-medium text-foreground/80">
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
    <div className="pointer-events-none fixed inset-0">
      {windows.map((win) => (
        <Window key={win.id} win={win} />
      ))}
    </div>
  );
}
