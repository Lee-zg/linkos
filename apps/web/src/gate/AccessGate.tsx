import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessPolicy, SessionProfile } from "@linkos/protocol";
import {
  ApiError,
  createSession,
  dropSession,
  fetchMe,
  fetchPolicy,
} from "../lib/api";
import { refreshProfile } from "../lib/session";

type Phase =
  | { kind: "boot" }
  | { kind: "offline" }
  | { kind: "gate"; policy: AccessPolicy }
  | { kind: "pending" }
  | { kind: "rejected" };

const PENDING_POLL_MS = 3000;

function profileFromSession(
  session: Awaited<ReturnType<typeof createSession>>,
): SessionProfile {
  return {
    userId: session.userId,
    displayName: session.displayName,
    role: session.role,
    accessType: session.accessType,
    status: session.status,
    workspaceId: session.workspaceId,
  };
}

export function AccessGate({
  onEnter,
}: {
  onEnter: (profile: SessionProfile) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "boot" });
  const [displayName, setDisplayName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<number | undefined>(undefined);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== undefined) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = undefined;
    }
  }, []);

  const showGate = useCallback(async () => {
    setPhase({ kind: "boot" });
    setError(null);
    try {
      const policy = await fetchPolicy();
      setPhase({ kind: "gate", policy });
    } catch {
      setPhase({ kind: "offline" });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (me) refreshProfile(me);
        if (me?.status === "active") {
          onEnter(me);
          return;
        }
        if (me?.status === "pending") {
          setPhase({ kind: "pending" });
          return;
        }
        if (me?.status === "rejected") {
          setPhase({ kind: "rejected" });
          return;
        }
        dropSession();
        await showGate();
      } catch {
        if (!cancelled) setPhase({ kind: "offline" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // The boot check must run exactly once per gate mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase.kind !== "pending") return;
    pollTimer.current = window.setInterval(async () => {
      try {
        const me = await fetchMe();
        if (me?.status === "active") {
          stopPolling();
          refreshProfile(me);
          onEnter(me);
        } else if (me?.status === "rejected") {
          stopPolling();
          refreshProfile(me);
          setPhase({ kind: "rejected" });
        } else if (!me) {
          stopPolling();
          dropSession();
          await showGate();
        }
      } catch {
        // Transient network failure — keep polling.
      }
    }, PENDING_POLL_MS);
    return stopPolling;
  }, [phase.kind, onEnter, showGate, stopPolling]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "操作失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = () =>
    run(async () => {
      if (!displayName.trim()) {
        setError("请输入显示名");
        return;
      }
      const session = await createSession({
        accessType: "login",
        displayName: displayName.trim(),
        passcode: passcode.trim() || undefined,
      });
      stopPolling();
      onEnter(profileFromSession(session));
    });

  const submitApplication = () =>
    run(async () => {
      if (!displayName.trim()) {
        setError("请输入显示名");
        return;
      }
      await createSession({
        accessType: "anonymous",
        displayName: displayName.trim(),
        note: note.trim() || undefined,
      });
      setPhase({ kind: "pending" });
    });

  const enterAsGuest = () =>
    run(async () => {
      const session = await createSession({ accessType: "guest" });
      stopPolling();
      onEnter(profileFromSession(session));
    });

  const backToGate = () => {
    dropSession();
    void showGate();
  };

  const policy = phase.kind === "gate" ? phase.policy : null;

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="wallpaper fixed inset-0" aria-hidden />
      <div className="relative z-10 flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-xl border border-white/60 bg-background p-6 shadow-2xl">
          <div className="mb-5 flex items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-foreground text-sm font-bold text-background">
              L
            </span>
            <div>
              <p className="m-0 text-base font-semibold leading-tight">
                LinkOS
              </p>
              <p className="m-0 text-xs text-muted-foreground">
                Nimbus Lab · 局域网工作区
              </p>
            </div>
          </div>

          {phase.kind === "boot" && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              正在连接工作区…
            </p>
          )}

          {phase.kind === "offline" && (
            <div className="flex flex-col gap-3 py-4">
              <p className="m-0 text-sm">无法连接网关服务。</p>
              <p className="m-0 text-xs text-muted-foreground">
                请确认 LinkOS Gateway 已启动（127.0.0.1:8787），然后重试。
              </p>
              <button
                className="cursor-pointer rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
                onClick={() => void showGate()}
              >
                重试
              </button>
            </div>
          )}

          {phase.kind === "pending" && (
            <div className="flex flex-col gap-3 py-4">
              <p className="m-0 text-sm font-medium">访问申请已提交</p>
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">
                正在等待管理员审批，审批通过后将自动进入工作区。
              </p>
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-2 w-2 animate-pulse rounded-full bg-warning" />
                等待审批中
              </span>
              <button
                className="mt-2 cursor-pointer self-start rounded-lg border bg-transparent px-3 py-1.5 text-xs hover:bg-accent"
                onClick={backToGate}
              >
                撤回并返回
              </button>
            </div>
          )}

          {phase.kind === "rejected" && (
            <div className="flex flex-col gap-3 py-4">
              <p className="m-0 text-sm font-medium text-destructive-foreground">
                访问申请未通过
              </p>
              <p className="m-0 text-xs text-muted-foreground">
                管理员拒绝了本次访问申请，你可以重新提交申请。
              </p>
              <button
                className="mt-2 cursor-pointer self-start rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
                onClick={backToGate}
              >
                重新申请
              </button>
            </div>
          )}

          {policy && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2.5">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  显示名
                  <input
                    className="rounded-lg border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
                    value={displayName}
                    placeholder="你的名字"
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  口令（可选）
                  <input
                    className="rounded-lg border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
                    type="password"
                    value={passcode}
                    placeholder="管理员口令可进入管理后台"
                    onChange={(event) => setPasscode(event.target.value)}
                  />
                </label>
                <button
                  className="cursor-pointer rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void submitLogin()}
                >
                  登录进入
                </button>
              </div>

              {policy.allowFullAnonymous && (
                <>
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    或
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <button
                    className="cursor-pointer rounded-lg border bg-transparent px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void enterAsGuest()}
                  >
                    以访客身份直接进入
                  </button>
                </>
              )}

              {policy.allowAnonymousApplication &&
                !policy.allowFullAnonymous && (
                  <>
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span className="h-px flex-1 bg-border" />
                      或
                      <span className="h-px flex-1 bg-border" />
                    </div>
                    <div className="flex flex-col gap-2.5">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        申请说明（可选）
                        <input
                          className="rounded-lg border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
                          value={note}
                          placeholder="简单说明访问目的"
                          onChange={(event) => setNote(event.target.value)}
                        />
                      </label>
                      <button
                        className="cursor-pointer rounded-lg border bg-transparent px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
                        disabled={busy}
                        onClick={() => void submitApplication()}
                      >
                        提交访问申请
                      </button>
                      <p className="m-0 text-xs text-muted-foreground">
                        提交后需等待管理员审批，通过后自动进入。
                      </p>
                    </div>
                  </>
                )}

              {error && (
                <p className="m-0 text-xs text-destructive-foreground" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
