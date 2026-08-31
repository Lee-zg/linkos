import { useState } from "react";
import { useToast } from "../os/Toaster";

function Row({
  label,
  desc,
  control,
}: {
  label: string;
  desc: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="m-0 text-sm font-medium">{label}</p>
        <p className="m-0 mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      {control}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      className={`h-5 w-9 shrink-0 cursor-pointer rounded-full border-none p-0.5 transition-colors ${
        checked ? "bg-foreground" : "bg-input"
      }`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
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

export function SettingsApp() {
  const toast = useToast();
  const [notifications, setNotifications] = useState(true);
  const [autoStart, setAutoStart] = useState(false);
  return (
    <div className="flex flex-col gap-4 p-4">
      <section className="rounded-lg border bg-card px-4 py-2">
        <h3 className="m-0 pt-2 text-sm font-semibold">工作区</h3>
        <div className="divide-y">
          <Row
            label="工作区名称"
            desc="Nimbus Lab · 局域网工作区"
            control={
              <button
                className="shrink-0 cursor-pointer rounded-lg border bg-transparent px-3 py-1.5 text-xs hover:bg-accent"
                onClick={() => toast("工作区重命名即将开放")}
              >
                重命名
              </button>
            }
          />
          <Row
            label="系统通知"
            desc="任务完成、消息提醒等系统级通知"
            control={
              <Toggle
                checked={notifications}
                onChange={() => setNotifications((v) => !v)}
                label="系统通知"
              />
            }
          />
          <Row
            label="随系统启动"
            desc="登录后自动连接工作区"
            control={
              <Toggle
                checked={autoStart}
                onChange={() => setAutoStart((v) => !v)}
                label="随系统启动"
              />
            }
          />
        </div>
      </section>
      <section className="rounded-lg border bg-card px-4 py-2">
        <h3 className="m-0 pt-2 text-sm font-semibold">诊断</h3>
        <div className="divide-y">
          <Row
            label="诊断包"
            desc="收集连接与运行日志用于排查问题"
            control={
              <button
                className="shrink-0 cursor-pointer rounded-lg border bg-transparent px-3 py-1.5 text-xs hover:bg-accent"
                onClick={() => toast("诊断包已准备好下载")}
              >
                生成
              </button>
            }
          />
          <Row
            label="关于"
            desc="LinkOS 0.1.0 · 本地优先的插件化协作工作区"
            control={<span className="text-xs text-muted-foreground">0.1.0</span>}
          />
        </div>
      </section>
    </div>
  );
}
