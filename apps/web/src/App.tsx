import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionProfile } from "@linkos/protocol";
import { WindowManagerProvider } from "./os/window-manager";
import { Desktop } from "./os/Desktop";
import { WindowLayer } from "./os/Window";
import { Dock } from "./os/Dock";
import { ToastProvider, useToast } from "./os/Toaster";
import { ContextMenuProvider } from "./os/ContextMenu";
import { WorkspaceProvider, useWorkspace } from "./lib/workspace";
import { SessionContext } from "./lib/session";
import { dropSession } from "./lib/api";
import { AccessGate } from "./gate/AccessGate";
import { AppRegistryProvider } from "./os/app-registry";

function Shell() {
  const { connected } = useWorkspace();
  const toast = useToast();
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    toast("系统就绪", "LinkOS 已连接 Nimbus Lab 工作区");
  }, [toast]);
  return (
    <>
      <Desktop />
      <WindowLayer />
      <Dock connected={connected} />
    </>
  );
}

function Workbench({
  profile,
  onExit,
}: {
  profile: SessionProfile;
  onExit: () => void;
}) {
  return (
    <SessionContext.Provider value={{ profile, exit: onExit }}>
      <WorkspaceProvider>
        <AppRegistryProvider>
          <WindowManagerProvider>
            <ContextMenuProvider>
              <Shell />
            </ContextMenuProvider>
          </WindowManagerProvider>
        </AppRegistryProvider>
      </WorkspaceProvider>
    </SessionContext.Provider>
  );
}

function App() {
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const exit = useCallback(() => {
    dropSession();
    setProfile(null);
  }, []);
  return (
    <ToastProvider>
      {profile ? (
        <Workbench profile={profile} onExit={exit} />
      ) : (
        <AccessGate onEnter={setProfile} />
      )}
    </ToastProvider>
  );
}

export default App;
