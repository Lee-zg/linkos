import { useCallback, useEffect, useState } from "react";
import type {
  AccessPolicy,
  AccessRecord,
  AuditEntry,
} from "@linkos/protocol";
import {
  approveAccessRecord,
  fetchPolicy,
  listAccessRecords,
  listAuditEntries,
  rejectAccessRecord,
  updateAccessPolicy,
} from "../lib/api";
import { useSession } from "../lib/session";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";

const POLL_INTERVAL_MS = 10_000;

const accessTypeLabels: Record<string, string> = {
  login: "登录访问",
  anonymous: "匿名申请",
  guest: "访客",
};

const statusMeta: Record<string, { label: string; className: string }> = {
  pending: { label: "待审批", className: "bg-warning/15 text-warning-foreground" },
  active: { label: "已通过", className: "bg-success/15 text-success-foreground" },
  rejected: { label: "已拒绝", className: "bg-destructive/10 text-destructive-foreground" },
  revoked: { label: "已吊销", className: "bg-muted text-muted-foreground" },
};

const auditActionLabels: Record<string, string> = {
  "session.issue": "会话签发",
  "session.denied": "会话拒绝",
  "access.policy.update": "策略变更",
  "access.record.approve": "审批通过",
  "access.record.reject": "审批拒绝",
};

const AUDIT_DISPLAY_LIMIT = 50;

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      className={`h-5 w-9 shrink-0 cursor-pointer rounded-full border-none p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-foreground" : "bg-input"
      }`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span
        className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export function AdminApp() {
  const { profile } = useSession();
  const { lastEvent } = useWorkspace();
  const toast = useToast();
  const [policy, setPolicy] = useState<AccessPolicy | null>(null);
  const [records, setRecords] = useState<AccessRecord[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [policyResult, recordsResult, auditResult] = await Promise.all([
        fetchPolicy(),
        listAccessRecords(),
        listAuditEntries(),
      ]);
      setPolicy(policyResult);
      setRecords(recordsResult.items ?? []);
      setAuditEntries(auditResult.items ?? []);
      setError(null);
    } catch {
      setError("管理数据加载失败，请检查网关连接与登录状态。");
    }
  }, []);

  useEffect(() => {
    if (profile.role !== "admin") return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [profile.role, refresh]);

  useEffect(() => {
    if (!lastEvent || !lastEvent.type.startsWith("access.")) return;
    void refresh();
  }, [lastEvent, refresh]);

  if (profile.role !== "admin") {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        管理后台仅对管理员开放。
      </div>
    );
  }

  const applyPolicy = async (patch: Partial<AccessPolicy>) => {
    setSavingPolicy(true);
    try {
      const updated = await updateAccessPolicy(patch);
      setPolicy(updated);
      toast("访问策略已更新");
    } catch {
      toast("更新失败", "访问策略未保存，请重试。");
      void refresh();
    } finally {
      setSavingPolicy(false);
    }
  };

  const review = async (record: AccessRecord, action: "approve" | "reject") => {
    setBusyId(record.id);
    try {
      const updated =
        action === "approve"
          ? await approveAccessRecord(record.id)
          : await rejectAccessRecord(record.id);
      setRecords((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      toast(
        action === "approve" ? "已通过申请" : "已拒绝申请",
        `${record.displayName} 的访问申请已${
          action === "approve" ? "通过" : "拒绝"
        }`,
      );
    } catch {
      toast("操作失败", "审批结果未保存，请重试。");
      void refresh();
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = records.filter((r) => r.status === "pending").length;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {error && (
        <p
          className="m-0 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
          role="alert"
        >
          {error}
        </p>
      )}

      <section className="rounded-lg border bg-card px-4 py-2">
        <h3 className="m-0 pt-2 text-sm font-semibold">访问设置</h3>
        <p className="m-0 mt-0.5 pb-1 text-xs text-muted-foreground">
          登录访问始终开启；以下两种匿名模式可随时切换。
        </p>
        <div className="divide-y">
          <div className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm font-medium">匿名申请访问</p>
              <p className="m-0 mt-0.5 text-xs text-muted-foreground">
                访客提交访问申请，管理员审批通过后进入工作区。
              </p>
            </div>
            <Toggle
              checked={policy?.allowAnonymousApplication ?? false}
              disabled={savingPolicy || (policy?.allowFullAnonymous ?? false)}
              onChange={() =>
                void applyPolicy({
                  allowAnonymousApplication:
                    !policy?.allowAnonymousApplication,
                })
              }
              label="匿名申请访问"
            />
          </div>
          <div className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm font-medium">完全匿名访问</p>
              <p className="m-0 mt-0.5 text-xs text-muted-foreground">
                访客无需申请或登录，直接进入工作区。
              </p>
            </div>
            <Toggle
              checked={policy?.allowFullAnonymous ?? false}
              disabled={savingPolicy}
              onChange={() =>
                void applyPolicy({
                  allowFullAnonymous: !policy?.allowFullAnonymous,
                })
              }
              label="完全匿名访问"
            />
          </div>
        </div>
        {policy?.allowFullAnonymous && (
          <p className="m-0 mb-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            完全匿名已开启：访客将直接进入，匿名申请流程暂停生效。
          </p>
        )}
      </section>

      <section className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card px-4 py-2">
        <div className="flex items-baseline justify-between pt-2">
          <h3 className="m-0 text-sm font-semibold">用户模块</h3>
          <span className="text-xs text-muted-foreground">
            共 {records.length} 条记录 · {pendingCount} 条待审批
          </span>
        </div>
        <div className="mt-2 flex flex-col divide-y">
          {records.length === 0 && (
            <p className="m-0 py-6 text-center text-xs text-muted-foreground">
              暂无访问记录。
            </p>
          )}
          {records.map((record) => {
            const status = statusMeta[record.status] ?? statusMeta.pending;
            return (
              <div key={record.id} className="flex items-center gap-3 py-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-xs font-semibold text-muted-foreground">
                  {record.displayName.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{record.displayName}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {accessTypeLabels[record.accessType] ?? record.accessType}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </p>
                  <p className="m-0 mt-0.5 truncate text-xs text-muted-foreground">
                    {record.note ? `${record.note} · ` : ""}
                    {formatTime(record.createdAt)}
                    {record.reviewedAt ? ` · 审批于 ${formatTime(record.reviewedAt)}` : ""}
                  </p>
                </div>
                {record.status === "pending" ? (
                  <div className="flex shrink-0 gap-1.5">
                    <button
                      className="cursor-pointer rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
                      disabled={busyId === record.id}
                      onClick={() => void review(record, "approve")}
                    >
                      通过
                    </button>
                    <button
                      className="cursor-pointer rounded-lg border bg-transparent px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                      disabled={busyId === record.id}
                      onClick={() => void review(record, "reject")}
                    >
                      拒绝
                    </button>
                  </div>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    —
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg border bg-card px-4 py-2">
        <div className="flex items-baseline justify-between pt-2">
          <h3 className="m-0 text-sm font-semibold">审计日志</h3>
          <span className="text-xs text-muted-foreground">
            共 {auditEntries.length} 条
            {auditEntries.length > AUDIT_DISPLAY_LIMIT
              ? ` · 仅显示最近 ${AUDIT_DISPLAY_LIMIT} 条`
              : ""}
          </span>
        </div>
        <p className="m-0 mt-0.5 pb-1 text-xs text-muted-foreground">
          会话签发、策略变更与审批操作按时间倒序记录；内存模式重启后清空，配置
          LINKOS_DATA_DIR 后持久保存。
        </p>
        <div className="mb-2 flex flex-col divide-y">
          {auditEntries.length === 0 && (
            <p className="m-0 py-6 text-center text-xs text-muted-foreground">
              暂无审计记录。
            </p>
          )}
          {auditEntries.slice(0, AUDIT_DISPLAY_LIMIT).map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 py-2">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {formatTime(entry.at)}
              </span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {auditActionLabels[entry.action] ?? entry.action}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs">
                {entry.actorName || "系统"}
                {entry.detail ? ` · ${entry.detail}` : ""}
                {entry.target ? ` · ${entry.target}` : ""}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
