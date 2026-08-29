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
