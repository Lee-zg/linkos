import { useEffect, useRef } from "react";
import { WindowManagerProvider } from "./os/window-manager";
import { Desktop } from "./os/Desktop";
import { WindowLayer } from "./os/Window";
import { Dock } from "./os/Dock";
import { ToastProvider, useToast } from "./os/Toaster";
import { WorkspaceProvider, useWorkspace } from "./lib/workspace";

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

function App() {
  return (
    <ToastProvider>
      <WorkspaceProvider>
        <WindowManagerProvider>
          <Shell />
        </WindowManagerProvider>
      </WorkspaceProvider>
    </ToastProvider>
  );
}

export default App;
