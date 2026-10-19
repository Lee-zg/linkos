import type { PluginContextMenuOpen } from "@linkos/protocol";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 100;
const coordinate = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= maximum;

export function parsePluginMenu(
  value: unknown,
  commands: ReadonlyMap<string, { title: string }>,
  viewport: { width: number; height: number },
): PluginContextMenuOpen {
  const invalid = () => new Error("插件菜单格式、命令或坐标无效");
  if (
    !record(value) ||
    !Number.isSafeInteger(value.seq) ||
    Number(value.seq) <= 0 ||
    !identifier(value.registrationId) ||
    !record(value.anchor) ||
    !coordinate(value.anchor.x, viewport.width) ||
    !coordinate(value.anchor.y, viewport.height) ||
    !Array.isArray(value.groups) ||
    value.groups.length > 8
  )
    throw invalid();
  const seen = new Set<string>();
  const groupIds = new Set<string>();
  const groups = value.groups.map((group) => {
    if (
      !record(group) ||
      !identifier(group.id) ||
      groupIds.has(group.id) ||
      !Array.isArray(group.items) ||
      group.items.length > 32
    )
      throw invalid();
    groupIds.add(group.id);
    return {
      id: group.id,
      items: group.items.map((item) => {
        if (
          !record(item) ||
          !identifier(item.commandId) ||
          !commands.has(item.commandId) ||
          seen.has(item.commandId) ||
          (item.disabled !== undefined && typeof item.disabled !== "boolean")
        )
          throw invalid();
        seen.add(item.commandId);
        if (seen.size > 32) throw invalid();
        return item.disabled === undefined
          ? { commandId: item.commandId }
          : { commandId: item.commandId, disabled: item.disabled };
      }),
    };
  });
  return {
    seq: Number(value.seq),
    registrationId: value.registrationId,
    anchor: { x: value.anchor.x, y: value.anchor.y },
    groups,
  };
}

export function pluginMenuAnchor(
  anchor: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  frame: {
    offsetWidth: number;
    offsetHeight: number;
    clientLeft: number;
    clientTop: number;
  },
) {
  if (frame.offsetWidth <= 0 || frame.offsetHeight <= 0)
    throw new Error("插件窗口不可见");
  return {
    x:
      rect.left +
      ((frame.clientLeft + anchor.x) * rect.width) / frame.offsetWidth,
    y:
      rect.top +
      ((frame.clientTop + anchor.y) * rect.height) / frame.offsetHeight,
  };
}

export interface PluginMenuRequestTicket {
  seq: number;
  generation: number;
}

/** A cancellation can invalidate only this connection's matching request. */
export class PluginMenuRequests {
  private latest = 0;
  private generation = 0;
  private current: PluginMenuRequestTicket | null = null;

  begin(seq: number): PluginMenuRequestTicket | null {
    if (!Number.isSafeInteger(seq) || seq <= this.latest) return null;
    this.latest = seq;
    return (this.current = { seq, generation: ++this.generation });
  }

  cancel(seq: number): boolean {
    if (this.current?.seq !== seq) return false;
    this.invalidate();
    return true;
  }

  invalidate() {
    this.current = null;
    this.generation++;
  }
  isCurrent(ticket: PluginMenuRequestTicket) {
    return this.current === ticket && ticket.generation === this.generation;
  }
}
