import { createContext, useContext } from "react";
import type { SessionProfile } from "@linkos/protocol";

const TOKEN_KEY = "linkos.access_token";
const PROFILE_KEY = "linkos.access_profile";

export function loadToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function loadProfile(): SessionProfile | null {
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as SessionProfile) : null;
  } catch {
    return null;
  }
}

export function saveSession(token: string, profile: SessionProfile): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // Storage unavailable — the session stays in memory for this tab.
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(PROFILE_KEY);
  } catch {
    // ignore storage failures on cleanup
  }
}

/** Updates the persisted profile snapshot without touching the token. */
export function refreshProfile(profile: SessionProfile): void {
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // Storage unavailable — the in-memory profile stays authoritative.
  }
}

export type SessionContextValue = {
  profile: SessionProfile;
  exit: () => void;
};

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionContext");
  return ctx;
}
