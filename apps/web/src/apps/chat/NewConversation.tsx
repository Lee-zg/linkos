import { useEffect, useState } from "react";
import type { ChatChannel } from "@linkos/protocol";
import { createChannel, listChatMembers } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Modal } from "../FileActions";

export function NewConversation({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (channel: ChatChannel) => void;
}) {
  const { profile } = useSession();
  const [kind, setKind] = useState<"channel" | "direct">("channel");
  const [name, setName] = useState("");
  const [members, setMembers] = useState<
    Array<{ userId: string; displayName: string }>
  >([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void listChatMembers()
      .then((result) =>
        setMembers(
          result.items.filter((item) => item.userId !== profile.userId),
        ),
      )
      .catch(() => setError("成员列表暂不可用"));
  }, [profile.userId]);
  return (
    <Modal title="新建会话" busy={busy} onClose={onClose}>
      <div className="mb-4 grid grid-cols-2 rounded-lg bg-muted p-1">
        {(
          [
            ["channel", "团队频道"],
            ["direct", "私密会话"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={`rounded-md px-2 py-2 text-xs ${kind === value ? "bg-white shadow-sm" : ""}`}
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === "channel" ? (
        <input
          aria-label="频道名称"
          placeholder="例如：产品设计"
          className="w-full rounded-lg border p-2 text-sm"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      ) : (
        <label className="block text-xs">
          选择联系人
          <select
            aria-label="联系人"
            className="mt-2 w-full rounded-lg border p-2 text-sm"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">选择工作区成员</option>
            {members.map((member) => (
              <option value={member.userId} key={member.userId}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="my-3 text-xs leading-relaxed text-muted-foreground">
        {kind === "direct"
          ? "仅会话成员可以查看消息和接收附件。"
          : "工作区成员可以加入、搜索并接收频道中的文件。"}
      </p>
      {error && (
        <p className="my-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
      <button
        className="w-full rounded-lg bg-blue-600 p-2 text-sm text-white disabled:opacity-40"
        disabled={busy || (kind === "channel" ? !name.trim() : !selected)}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const channel = await createChannel({
              name:
                kind === "channel"
                  ? name.trim()
                  : `${profile.displayName}、${members.find((item) => item.userId === selected)?.displayName}`,
              kind,
              memberIds: kind === "direct" ? [selected] : undefined,
            });
            onCreated(channel);
          } catch (err) {
            setError(err instanceof Error ? err.message : "创建失败");
          } finally {
            setBusy(false);
          }
        }}
      >
        开始会话
      </button>
    </Modal>
  );
}
