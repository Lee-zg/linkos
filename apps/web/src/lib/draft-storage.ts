// Keep the latest draft in this browser session when storage is unavailable.
// Callers scope keys by gateway, workspace and user.
type Copy = { value: string | null; pending: boolean };
const storageCopies = new WeakMap<Storage, Map<string, Copy>>();
const unavailable = new Map<string, Copy>();
function context() {
  try {
    const storage = localStorage;
    let copies = storageCopies.get(storage);
    if (!copies) {
      copies = new Map();
      storageCopies.set(storage, copies);
    }
    return { storage, copies };
  } catch {
    return { storage: undefined, copies: unavailable };
  }
}
export function readDraft(key: string): string | null {
  const { storage, copies } = context(),
    copy = copies.get(key);
  if (copy?.pending) return copy.value;
  try {
    return storage ? storage.getItem(key) : (copy?.value ?? null);
  } catch {
    return copy?.value ?? null;
  }
}
export function writeDraft(key: string, value: string): void {
  const { storage, copies } = context();
  const copy = { value, pending: true };
  copies.set(key, copy);
  try {
    if (storage) {
      storage.setItem(key, value);
      copy.pending = false;
    }
  } catch {
    /* session copy survives */
  }
}
export function removeDraft(key: string): void {
  const { storage, copies } = context();
  const copy = { value: null, pending: true };
  copies.set(key, copy);
  try {
    if (storage) {
      storage.removeItem(key);
      copy.pending = false;
    }
  } catch {
    /* session tombstone survives */
  }
}
