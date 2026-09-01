import type {
  AcceptedMessage,
  JobRef,
  JobSpec,
  MessageCreateInput,
  SessionToken,
} from "@linkos/protocol";

let accessToken: string | null = null;
let sessionRequest: Promise<string | null> | null = null;

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
	const url = typeof input === "string" ? input : input.toString();
	if (!url.endsWith("/api/v1/sessions") && !url.endsWith("/api/v1/healthz") && !url.endsWith("/api/v1/discovery")) {
		await ensureSession();
	}
	const headers = new Headers(init?.headers);
	if (accessToken && !headers.has("authorization")) {
		headers.set("authorization", `Bearer ${accessToken}`);
	}
	let response: Response;
	try {
		response = await fetch(input, { ...init, headers });
  } catch (error) {
    throw new ApiError(
      0,
      error instanceof Error ? error.message : "网络连接失败",
    );
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok) {
      throw new ApiError(response.status, "服务器返回了无效数据");
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "message" in payload
        ? String(payload.message)
        : typeof payload === "object" && payload !== null && "error" in payload
          ? String(payload.error)
          : `请求失败（${response.status}）`;
    throw new ApiError(response.status, message);
  }

  return payload as T;
}

export async function ensureSession(): Promise<string | null> {
	if (accessToken) return accessToken;
	if (sessionRequest) return sessionRequest;
	sessionRequest = (async () => {
		try {
			const response = await fetch("/api/v1/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ workspaceId: "demo", displayName: "本地设备" }),
			});
			if (!response.ok) return null;
			const payload = (await response.json()) as SessionToken;
			if (typeof payload.accessToken !== "string" || !payload.accessToken) return null;
			accessToken = payload.accessToken;
			return accessToken;
		} catch {
			return null;
		} finally {
			sessionRequest = null;
		}
	})();
	return sessionRequest;
}

export function getSessionToken() {
	return accessToken;
}

export function sendMessage(payload: MessageCreateInput) {
  return request<AcceptedMessage>("/api/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function submitJob(spec: JobSpec) {
  return request<JobRef>("/api/v1/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
}

export { ApiError };
