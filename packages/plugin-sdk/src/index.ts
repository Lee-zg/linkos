import type {
  DomainEvent,
  JobRef,
  JobSpec,
  PluginManifest,
  ResourceRef,
} from "@linkos/protocol";

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
    const commands = new Map<string, () => void | Promise<void>>();
    const subscriptions = new Map<string, (event: DomainEvent) => void>();
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error("PLUGIN_HANDSHAKE_TIMEOUT"));
    }, 5000);
    function dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
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
          } else if (data?.type === "event")
            subscriptions.get(data.subscriptionId)?.(data.event);
          else if (data?.type === "command") void commands.get(data.id)?.();
        };
        port.start();
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
            registerCommand: (command) => {
              commands.set(command.id, command.run);
              void rpc("ui.registerCommand", {
                id: command.id,
                title: command.title,
              }).catch(() => commands.delete(command.id));
              return () => {
                commands.delete(command.id);
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
