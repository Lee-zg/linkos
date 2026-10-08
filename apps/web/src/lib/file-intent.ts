type Location = "downloads" | "trash";
let pending: Location | null = null;
const listeners = new Set<(location: Location) => void>();
export function requestFileLocation(location: Location) {
  pending = listeners.size ? null : location;
  for (const listener of listeners) listener(location);
}
export function subscribeFileLocation(listener: (location: Location) => void) {
  listeners.add(listener);
  if (pending) {
    listener(pending);
    pending = null;
  }
  return () => {
    listeners.delete(listener);
  };
}
