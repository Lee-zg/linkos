import type { AppDefinition } from "./types";

export function AppIcon({
  app,
  size = 56,
}: {
  app: AppDefinition;
  size?: number;
}) {
  const Icon = app.icon;
  return (
    <span
      className="grid shrink-0 place-items-center text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_2px_6px_rgb(0_0_0/0.18)]"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.24,
        background: app.gradient,
      }}
      aria-hidden="true"
    >
      <Icon size={size * 0.5} strokeWidth={1.8} />
    </span>
  );
}
