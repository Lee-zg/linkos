const DB_NAME = "linkos-identity";
const STORE_NAME = "devices";
const RECORD_KEY = "primary";

export type DeviceIdentity = { deviceId: string; publicKey: string };

function openIdentityDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function encodeBase64URL(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity | null> {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) return null;
  const db = await openIdentityDB();
  try {
    const existing = await new Promise<DeviceIdentity | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => resolve(request.result as DeviceIdentity | undefined);
      request.onerror = () => reject(request.error);
    });
    if (existing?.deviceId && existing.publicKey) return existing;

    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = encodeBase64URL(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const identity: DeviceIdentity & { privateKey: CryptoKey } = { deviceId: `dev_${crypto.randomUUID()}`, publicKey, privateKey: pair.privateKey };
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(identity, RECORD_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    return identity;
  } catch {
    return null;
  } finally { db.close(); }
}
