import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { getGatewayBase } from "../lib/api";
import { useSession } from "../lib/session";
import {
  applyDesktopPreferencesUpdate,
  createDesktopPreferencesStorageController,
  desktopPreferencesKey,
  type DesktopPreferencesIdentity,
  type DesktopPreferencesV1,
  type StorageLike,
} from "./desktop-preferences";

type DesktopPreferencesContextValue = {
  preferences: DesktopPreferencesV1;
  setPreferences: Dispatch<SetStateAction<DesktopPreferencesV1>>;
};

const DesktopPreferencesContext =
  createContext<DesktopPreferencesContextValue | null>(null);

function getBrowserStorage(): StorageLike | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function DesktopPreferencesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { profile } = useSession();
  const gateway = getGatewayBase();
  const identity = useMemo<DesktopPreferencesIdentity>(
    () => ({
      gateway,
      workspaceId: profile.workspaceId,
      userId: profile.userId,
    }),
    [gateway, profile.userId, profile.workspaceId],
  );
  const identityKey = desktopPreferencesKey(identity);
  const controllerRef = useRef(
    createDesktopPreferencesStorageController(getBrowserStorage()),
  );
  const [snapshot, setSnapshot] = useState(() =>
    controllerRef.current.hydrate(identity),
  );

  useEffect(() => {
    if (snapshot.key === identityKey) return;
    setSnapshot(controllerRef.current.hydrate(identity));
  }, [identity, identityKey, snapshot.key]);

  useEffect(() => {
    if (snapshot.key !== identityKey) return;
    controllerRef.current.write(snapshot.key, snapshot.preferences);
  }, [identityKey, snapshot]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const preferences = controllerRef.current.acceptStorage(
        event.key,
        event.newValue,
      );
      if (!preferences || event.key !== identityKey) return;
      setSnapshot({ key: identityKey, preferences });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [identityKey]);

  const setPreferences = useCallback<
    Dispatch<SetStateAction<DesktopPreferencesV1>>
  >(
    (update) => {
      setSnapshot((current) => {
        if (current.key !== identityKey) return current;
        const preferences = applyDesktopPreferencesUpdate(
          current.preferences,
          update,
        );
        return preferences === current.preferences
          ? current
          : { ...current, preferences };
      });
    },
    [identityKey],
  );

  const value = useMemo(
    () => ({ preferences: snapshot.preferences, setPreferences }),
    [setPreferences, snapshot.preferences],
  );
  return (
    <DesktopPreferencesContext.Provider value={value}>
      {children}
    </DesktopPreferencesContext.Provider>
  );
}

export function useDesktopPreferences(): DesktopPreferencesContextValue {
  const context = useContext(DesktopPreferencesContext);
  if (!context) {
    throw new Error(
      "useDesktopPreferences must be used within DesktopPreferencesProvider",
    );
  }
  return context;
}
