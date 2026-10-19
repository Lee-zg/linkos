import type {
  DomainEvent,
  JobRef,
  JobSpec,
  PluginManifest,
  ResourceRef,
  PluginContextMenuGroup,
  PluginContextMenuReference,
} from "@linkos/protocol";

export interface PluginMenuTrigger {
  source: "pointer" | "keyboard";
  target: HTMLElement;
  anchor: { x: number; y: number };
}

type MenuRegistration = {
  id: string;
  getItems: (trigger: PluginMenuTrigger) => PluginContextMenuGroup[] | null;
};
type RegisteredCommand = {
  run: () => void | Promise<void>;
  ready: Promise<unknown>;
};

export interface LinkOSPluginContext {
  manifest: PluginManifest;
  auth: {
    currentUser(): Promise<{ id: string; displayName: string }>;
    check(permission: string, resource?: ResourceRef): Promise<boolean>;
  };
  resources: {
    get<T = unknown>(ref: ResourceRef): Promise<T>;
    list<T = unknown>(query: {
      type?: string;
      cursor?: string;
    }): AsyncIterable<T>;
    put(input: {
      ref: ResourceRef;
      value: unknown;
      baseVersion?: string;
    }): Promise<{ version: string }>;
  };
  events: {
    publish(event: DomainEvent): Promise<void>;
    subscribe(
      filter: { type?: string; resourceId?: string },
      handler: (event: DomainEvent) => void,
    ): () => void;
  };
  jobs: {
    submit(input: JobSpec): Promise<JobRef>;
    cancel(jobId: string): Promise<void>;
  };
  ui: {
    registerContextMenu(
      target: HTMLElement,
      getItems: (trigger: PluginMenuTrigger) => PluginContextMenuGroup[] | null,
    ): () => void;
    registerCommand(command: {
      id: string;
      title: string;
      run: () => void | Promise<void>;
    }): () => void;
    notify(input: {
      title: string;
      body: string;
      tone?: "info" | "success" | "warning" | "error";
    }): void;
  };
}

export function validateManifest(manifest: PluginManifest): string[] {
  const errors: string[] = [];
  if (!manifest.id || !/^[a-z0-9][a-z0-9.-]+$/.test(manifest.id))
    errors.push("id must be a lowercase plugin identifier");
  if (!manifest.version) errors.push("version is required");
  if (!manifest.apiVersion) errors.push("apiVersion is required");
  if (!manifest.entry.ui && !manifest.entry.service && !manifest.entry.runner)
    errors.push("at least one entry is required");
  return errors;
}

export interface ConnectedPlugin extends LinkOSPluginContext {
  dispose(): void;
}
const messageBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Connect only to the enclosing host, then use the transferred private port. */
export function connectPlugin(
  manifest: PluginManifest,
): Promise<ConnectedPlugin> {
  return new Promise((resolve, reject) => {
    let nonce = "",
      hostOrigin = "",
      disposed = false,
      port: MessagePort | undefined;
    const requests = new Map<
      string,
      {
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const commands = new Map<string, RegisteredCommand>();
    const subscriptions = new Map<string, (event: DomainEvent) => void>();
    const menus = new Map<HTMLElement, MenuRegistration>();
    let menuSequence = 0;
    let keyboardGesture = false;
    let keyboardTimer: ReturnType<typeof setTimeout> | undefined;
    let focusLeft = false;
    let currentMenu: {
      seq: number;
      registration: MenuRegistration;
      target: HTMLElement;
      token?: string;
      commands: Map<string, RegisteredCommand>;
    } | null = null;

    function cancelMenu() {
      const old = currentMenu;
      currentMenu = null;
      if (old && port && !disposed) {
        // Cancellation is bounded, fire-and-forget control, not a business RPC slot.
        port.postMessage({
          type: "request",
          id: crypto.randomUUID(),
          method: "ui.contextMenu.cancel",
          params: { seq: old.seq },
        });
      }
    }
    async function showMenu(
      event: MouseEvent | KeyboardEvent,
      source: "pointer" | "keyboard",
    ) {
      cancelMenu();
      if (disposed || !port || ("isComposing" in event && event.isComposing))
        return;
      const sequence = ++menuSequence;
      const path = event.composedPath();
      const element = path.find(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );
      const registeredElement = path.find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && menus.has(node),
      );
      if (!element || !registeredElement) return;
      const registration = menus.get(registeredElement)!;
      const rect = element.getBoundingClientRect();
      const anchor =
        source === "pointer"
          ? {
              x: (event as MouseEvent).clientX,
              y: (event as MouseEvent).clientY,
            }
          : { x: rect.left, y: rect.bottom };
      try {
        const groups = registration.getItems({
          source,
          target: element,
          anchor,
        });
        if (!groups?.some((group) => group.items.length)) return;
        const selectedCommands = new Map<string, RegisteredCommand>();
        for (const group of groups)
          for (const item of group.items) {
            const command = commands.get(item.commandId);
            if (!command) return;
            selectedCommands.set(item.commandId, command);
          }
        const menu = {
          seq: sequence,
          registration,
          target:
            element.closest<HTMLElement>(
              "button, input, textarea, select, a[href], [tabindex], [contenteditable]",
            ) ?? element,
          commands: selectedCommands,
          token: undefined as string | undefined,
        };
        currentMenu = menu;
        await Promise.all(
          [...selectedCommands.values()].map((command) => command.ready),
        );
        if (
          currentMenu !== menu ||
          menus.get(registeredElement) !== registration ||
          !element.isConnected ||
          [...selectedCommands].some(
            ([id, command]) => commands.get(id) !== command,
          )
        )
          return;
        const result = await rpc<{ token: string | null }>(
          "ui.contextMenu.open",
          { seq: menu.seq, registrationId: registration.id, anchor, groups },
        );
        if (currentMenu !== menu) return;
        if (result.token) menu.token = result.token;
        else currentMenu = null;
      } catch {
        if (currentMenu?.seq === sequence) cancelMenu();
      }
    }
    function contextMenu(event: MouseEvent) {
      event.preventDefault();
      if (keyboardGesture) {
        keyboardGesture = false;
        return;
      }
      void showMenu(event, "pointer");
    }
    function menuKey(event: KeyboardEvent) {
      if (event.isComposing) return;
      if (event.key === "Escape" || event.key === "Tab") {
        cancelMenu();
        return;
      }
      if (
        event.key !== "ContextMenu" &&
        !(event.shiftKey && event.key === "F10")
      )
        return;
      event.preventDefault();
      if (event.isComposing || event.repeat) return;
      keyboardGesture = true;
      void showMenu(event, "keyboard");
    }
    function releaseMenuKey() {
      clearTimeout(keyboardTimer);
      keyboardTimer = setTimeout(() => {
        keyboardGesture = false;
      }, 0);
    }
    function pointerDown() {
      keyboardGesture = false;
      cancelMenu();
    }
    function frameBlur() {
      focusLeft = true;
    }
    function frameFocus() {
      if (focusLeft) cancelMenu();
      focusLeft = false;
    }
    function takeMenu(reference: PluginContextMenuReference) {
      const menu = currentMenu;
      if (
        !menu ||
        menu.seq !== reference.seq ||
        (menu.token && menu.token !== reference.token)
      )
        return null;
      currentMenu = null;
      return menu;
    }
    function restoreMenuTarget(target: HTMLElement) {
      if (target.isConnected) target.focus({ preventScroll: true });
    }
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error("PLUGIN_HANDSHAKE_TIMEOUT"));
    }, 5000);
    function dispose() {
      if (disposed) return;
      cancelMenu();
      disposed = true;
      clearTimeout(timeout);
      clearTimeout(keyboardTimer);
      document.removeEventListener("contextmenu", contextMenu, true);
      document.removeEventListener("keydown", menuKey, true);
      document.removeEventListener("keyup", releaseMenuKey, true);
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("scroll", cancelMenu, true);
      window.removeEventListener("blur", frameBlur);
      window.removeEventListener("focus", frameFocus);
      menus.clear();
      window.removeEventListener("message", handshake);
      port?.close();
      for (const request of requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("PLUGIN_DISCONNECTED"));
      }
      requests.clear();
      commands.clear();
      subscriptions.clear();
    }
    function rpc<T>(method: string, params: unknown = {}): Promise<T> {
      if (disposed || !port)
        return Promise.reject(new Error("PLUGIN_DISCONNECTED"));
      if (requests.size >= 8)
        return Promise.reject(new Error("PLUGIN_RATE_LIMIT"));
      const id = crypto.randomUUID(),
        message = { type: "request", id, method, params };
      if (messageBytes(message) > 64 * 1024)
        return Promise.reject(new Error("PLUGIN_RPC_LIMIT"));
      return new Promise<T>((done, fail) => {
        const timer = setTimeout(() => {
          requests.delete(id);
          fail(new Error("PLUGIN_RPC_TIMEOUT"));
        }, 5000);
        requests.set(id, {
          resolve: (value) => done(value as T),
          reject: fail,
          timer,
        });
        port!.postMessage(message);
      });
    }
    function handshake(event: MessageEvent) {
      if (
        disposed ||
        event.source !== window.parent ||
        !event.data ||
        messageBytes(event.data) > 64 * 1024
      )
        return;
      const data = event.data;
      if (data.type === "linkos.host.init") {
        if (
          data.pluginId !== manifest.id ||
          data.version !== manifest.version ||
          data.protocol !== "1.0" ||
          typeof data.nonce !== "string"
        )
          return;
        if (nonce && (nonce !== data.nonce || hostOrigin !== event.origin))
          return;
        nonce = data.nonce;
        hostOrigin = event.origin;
        window.parent.postMessage(
          {
            type: "linkos.plugin.ready",
            pluginId: manifest.id,
            version: manifest.version,
            protocol: "1.0",
            nonce,
          },
          hostOrigin,
        );
      } else if (
        data.type === "linkos.host.connect" &&
        nonce &&
        data.nonce === nonce &&
        data.protocol === "1.0" &&
        event.origin === hostOrigin &&
        event.ports.length === 1
      ) {
        port = event.ports[0];
        clearTimeout(timeout);
        window.removeEventListener("message", handshake);
        port.onmessage = (event) => {
          if (disposed || messageBytes(event.data) > 64 * 1024) return;
          const data = event.data;
          if (data?.type === "response") {
            const request = requests.get(data.id);
            if (!request) return;
            requests.delete(data.id);
            clearTimeout(request.timer);
            if (data.error) request.reject(new Error(String(data.error)));
            else request.resolve(data.result);
          } else if (data?.type === "event") {
            subscriptions.get(data.subscriptionId)?.(data.event);
          } else if (data?.type === "context-menu.closed") {
            const menu = takeMenu(data);
            if (menu && data.restoreFocus) restoreMenuTarget(menu.target);
          } else if (data?.type === "command") {
            const command = commands.get(data.id);
            if (data.contextMenu) {
              const menu = takeMenu(data.contextMenu);
              if (!menu || !command || menu.commands.get(data.id) !== command)
                return;
              restoreMenuTarget(menu.target);
            }
            void command?.run();
          }
        };
        port.start();
        document.addEventListener("contextmenu", contextMenu, true);
        document.addEventListener("keydown", menuKey, true);
        document.addEventListener("keyup", releaseMenuKey, true);
        document.addEventListener("pointerdown", pointerDown, true);
        document.addEventListener("scroll", cancelMenu, true);
        window.addEventListener("blur", frameBlur);
        window.addEventListener("focus", frameFocus);
        const unsupported = () =>
          Promise.reject(new Error("PLUGIN_METHOD_UNSUPPORTED"));
        resolve({
          manifest,
          dispose,
          auth: {
            currentUser: () => rpc("auth.currentUser"),
            check: (permission, resource) =>
              rpc("auth.check", { permission, resourceId: resource?.id }),
          },
          resources: {
            get: (ref) => rpc("resources.get", { id: ref.id }),
            put: unsupported,
            async *list<T>(query: { type?: string; cursor?: string }) {
              let cursor = query.cursor;
              do {
                const result = await rpc<{ items: T[]; nextCursor: string }>(
                  "resources.list",
                  { ...query, cursor },
                );
                for (const item of result.items) yield item;
                cursor = result.nextCursor;
              } while (cursor);
            },
          },
          events: {
            publish: unsupported,
            subscribe: (filter, handler) => {
              let active = true,
                id: string | undefined;
              void rpc<string>("events.subscribe", filter)
                .then((value) => {
                  id = value;
                  if (active) subscriptions.set(value, handler);
                  else
                    void rpc("events.unsubscribe", { id: value }).catch(
                      () => undefined,
                    );
                })
                .catch(() => undefined);
              return () => {
                active = false;
                if (id) {
                  subscriptions.delete(id);
                  void rpc("events.unsubscribe", { id }).catch(() => undefined);
                }
              };
            },
          },
          jobs: { submit: unsupported, cancel: unsupported },
          ui: {
            notify: (input) => {
              void rpc("ui.notify", input).catch(() => undefined);
            },
            registerContextMenu: (target, getItems) => {
              if (disposed) return () => undefined;
              const registration = { id: crypto.randomUUID(), getItems };
              const previous = menus.get(target);
              if (previous && currentMenu?.registration === previous)
                cancelMenu();
              menus.set(target, registration);
              return () => {
                if (menus.get(target) !== registration) return;
                menus.delete(target);
                if (currentMenu?.registration === registration) cancelMenu();
              };
            },
            registerCommand: (command) => {
              const registered: RegisteredCommand = {
                run: command.run,
                ready: rpc("ui.registerCommand", {
                  id: command.id,
                  title: command.title,
                }),
              };
              if (currentMenu?.commands.has(command.id)) cancelMenu();
              commands.set(command.id, registered);
              void registered.ready.catch(() => {
                if (commands.get(command.id) !== registered) return;
                commands.delete(command.id);
                if (currentMenu?.commands.get(command.id) === registered)
                  cancelMenu();
              });
              return () => {
                if (commands.get(command.id) !== registered) return;
                commands.delete(command.id);
                if (currentMenu?.commands.get(command.id) === registered)
                  cancelMenu();
                void rpc("ui.unregisterCommand", { id: command.id }).catch(
                  () => undefined,
                );
              };
            },
          },
        });
      }
    }
    window.addEventListener("message", handshake);
  });
}
