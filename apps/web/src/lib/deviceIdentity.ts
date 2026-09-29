const DB_NAME = "linkos-identity";
const STORE_NAME = "devices";
const RECORD_KEY = "primary";

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  signChallenge: (message: string) => Promise<string>;
};

type StoredDeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: CryptoKey;
};

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

function signingIdentity(record: StoredDeviceIdentity): DeviceIdentity {
  // Keep the CryptoKey inside this closure; callers receive only a signing capability.
  return {
    deviceId: record.deviceId,
    publicKey: record.publicKey,
    async signChallenge(message) {
      const signature = await crypto.subtle.sign("Ed25519", record.privateKey, new TextEncoder().encode(message));
      return encodeBase64URL(new Uint8Array(signature));
    },
  };
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity | null> {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) return null;
  const db = await openIdentityDB();
  try {
    const existing = await new Promise<StoredDeviceIdentity | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => resolve(request.result as StoredDeviceIdentity | undefined);
      request.onerror = () => reject(request.error);
    });
    if (existing) {
      if (!existing.deviceId || !existing.publicKey || existing.privateKey?.type !== "private" ||
          existing.privateKey.algorithm.name !== "Ed25519" || !existing.privateKey.usages.includes("sign")) {
        throw new Error("设备私钥不可用，无法验证已有设备身份");
      }
      return signingIdentity(existing);
    }

    let pair: CryptoKeyPair;
    try {
      pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    } catch (error) {
      // Unsupported crypto can create a fresh no-device session, never reuse an identity.
      if (error instanceof DOMException && error.name === "NotSupportedError") return null;
      throw error;
    }
    const publicKey = encodeBase64URL(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const identity: StoredDeviceIdentity = { deviceId: `dev_${crypto.randomUUID()}`, publicKey, privateKey: pair.privateKey };
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("设备身份保存失败"));
      transaction.objectStore(STORE_NAME).put(identity, RECORD_KEY);
    });
    return signingIdentity(identity);
  } finally { db.close(); }
}
