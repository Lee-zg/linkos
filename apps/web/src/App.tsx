import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SessionProfile } from "@linkos/protocol";
import { WindowManagerProvider } from "./os/window-manager";
import { Desktop } from "./os/Desktop";
import { WindowLayer } from "./os/Window";
import { Dock } from "./os/Dock";
import { ToastProvider, useToast } from "./os/Toaster";
import { ContextMenuProvider, useContextMenu } from "./os/ContextMenu";
import { useWindowManager } from "./os/window-manager";
import { WorkspaceProvider, useWorkspace } from "./lib/workspace";
import { SessionContext } from "./lib/session";
import { dropSession } from "./lib/api";
import { AccessGate } from "./gate/AccessGate";
import { AppRegistryProvider, useAppRegistry } from "./os/app-registry";
import { DesktopPreferencesProvider } from "./os/DesktopPreferencesProvider";
import { DesktopViewportProvider } from "./os/useDesktopViewport";
import { DesktopChrome } from "./os/DesktopChrome";
import { SpaceOverview } from "./os/SpaceOverview";

function Shell() {
  const { connected } = useWorkspace();
  const { desktopState, viewport, focus } = useWindowManager();
  const { getApp } = useAppRegistry();
  const { controller } = useContextMenu();
  useLayoutEffect(() => {
    controller.dismiss();
  }, [controller, desktopState.transitionEpoch]);
  useLayoutEffect(() => {
    // CLOSE/MINIMIZE intentionally may clear canonical activeId. Mobile's
    // single-surface projection must select a surviving window through FOCUS,
    // rather than showing a hidden background DOM or inventing another activeId.
    if (
      viewport.w >= 768 ||
      desktopState.activeId ||
      desktopState.overviewReturn
    )
      return;
    const survivor = desktopState.windows
      .filter(
        (win) =>
          win.spaceId === desktopState.currentSpaceId &&
          !win.minimized &&
          getApp(win.appId),
      )
      .sort((a, b) => b.z - a.z)[0];
    if (survivor) focus(survivor.id);
  }, [desktopState, viewport.w, getApp, focus]);
  const toast = useToast();
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    toast("系统就绪", "LinkOS 已连接 Nimbus Lab 工作区");
  }, [toast]);
  return (
    <div
      className="desktop-shell"
      data-current-space={desktopState.currentSpaceId}
      data-space-type={
        desktopState.spaces.find(
          (space) => space.id === desktopState.currentSpaceId,
        )?.type
      }
      data-overview={!!desktopState.overviewReturn}
    >
      <DesktopChrome />
      <Desktop />
      <WindowLayer />
      <SpaceOverview />
      <Dock connected={connected} />
    </div>
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
          <DesktopPreferencesProvider>
            <DesktopViewportProvider>
              <WindowManagerProvider>
                <ContextMenuProvider>
                  <Shell />
                </ContextMenuProvider>
              </WindowManagerProvider>
            </DesktopViewportProvider>
          </DesktopPreferencesProvider>
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
