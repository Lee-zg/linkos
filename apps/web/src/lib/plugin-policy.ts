import type { PluginRecord } from "@linkos/protocol";

export const builtinAppIDs = {
  "files.core": "files",
  "chat.core": "chat",
  "code.workbench": "code",
  "runner.exec": "tasks",
} as const;
export function isBuiltinPlugin(id: string): id is keyof typeof builtinAppIDs {
  return Object.prototype.hasOwnProperty.call(builtinAppIDs, id);
}
export function pluginHasPermission(plugin: PluginRecord, permission: string) {
  return plugin.permissions.some(
    (declared) =>
      declared === permission ||
      (declared.endsWith("*") && permission.startsWith(declared.slice(0, -1))),
  );
}
export function rpcByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Infinity;
  }
}
export function pluginEventMetadata(event: {
  type: string;
  seq: number;
  eventId: string;
  payload?: unknown;
}) {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  return {
    type: event.type,
    seq: event.seq,
    eventId: event.eventId,
    resourceId:
      typeof payload.resourceId === "string" ? payload.resourceId : undefined,
  };
}
