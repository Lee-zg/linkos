import { useState } from "react";
import { apps } from "./apps";
import { AppIcon } from "./AppIcon";
import { useWindowManager } from "./window-manager";

export function Desktop() {
  const { open } = useWindowManager();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div
      className="wallpaper fixed inset-0 overflow-hidden"
      onPointerDown={() => setSelected(null)}
    >
      <div className="desktop-icons relative z-[1] p-3">
        {apps.map((app) => (
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
            onDoubleClick={() => open(app.id)}
            onClick={() => {
              if (window.matchMedia("(max-width: 767px)").matches) open(app.id);
            }}
            onKeyDown={(event) => {
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
