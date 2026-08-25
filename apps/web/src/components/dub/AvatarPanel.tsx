import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { createAvatar, deleteAvatar, favoriteAvatar, getTask, listAvatars, type DubAvatar, type DubPricing } from "../../dubApi";
import { estimatePerCall } from "../../dubWizard";

const MAX_BYTES = 100 * 1024 * 1024;
const POLL_MS = 3000;

export interface AvatarPanelProps {
  readonly token: string;
  readonly pricing: DubPricing | null;
  readonly selectedAvatarId: string | null;
  readonly onSelect: (id: string) => void;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
  readonly onErr: (msg: string) => void;
}

export function AvatarPanel({ token, pricing, selectedAvatarId, onSelect, busy, setBusy, onErr }: AvatarPanelProps) {
  const [avatars, setAvatars] = useState<DubAvatar[]>([]);
  const [cloning, setCloning] = useState<string | null>(null); // taskId
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try { setAvatars(await listAvatars(token)); } catch { /* 列表失败不阻断 */ }
  }, [token]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 克隆是异步任务：轮询到终态再刷新列表
  useEffect(() => {
    if (!cloning) return;
    let stop = false;
    const tick = async () => {
      try {
        const t = await getTask(token, cloning);
        if (stop) return;
        if (t.status === "completed") {
          setCloning(null); setBusy(false);
          await refresh();
        } else if (t.status === "failed") {
          setCloning(null); setBusy(false);
          onErr(t.error ?? "数字人克隆失败");
        }
      } catch { /* 轮询失败下轮重试 */ }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [cloning, token, refresh, setBusy, onErr]);

  const priced = pricing?.avatarClone.enabled ?? false;
  const estimate = pricing ? estimatePerCall(pricing.avatarClone) : null;

  const pick = async (f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) { onErr("仅支持视频文件"); return; }
    if (f.size > MAX_BYTES) { onErr("场景视频不能超过 100MB"); return; }
    setBusy(true);
    try {
      const { taskId } = await createAvatar(token, f, title.trim() || "我的数字人");
      setCloning(taskId);
    } catch (e) {
      setBusy(false);
      onErr((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    try { await deleteAvatar(token, id); await refresh(); } catch (e) { onErr((e as Error).message); }
  };
  const star = async (a: DubAvatar) => {
    try { await favoriteAvatar(token, a.id, !a.isFavorite); await refresh(); } catch (e) { onErr((e as Error).message); }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {avatars.map((a) => (
          <div
            key={a.id}
            className={`rounded-xl border p-3 ${selectedAvatarId === a.id ? "border-brand bg-brand/5" : "border-hairline-subtle"}`}
          >
            <button onClick={() => onSelect(a.id)} className="flex w-full items-center gap-2 text-left">
              <Icon icon="mdi:account-voice" className="text-xl text-brand" />
              <span className="truncate text-[13px] font-medium text-ink">{a.title}</span>
            </button>
            <div className="mt-2 flex gap-2 text-[11px]">
              <button onClick={() => void star(a)} className="text-ink-tertiary ">
                <Icon icon={a.isFavorite ? "mdi:star" : "mdi:star-outline"} className="text-base" />
              </button>
              <button onClick={() => void remove(a.id)} className="text-ink-tertiary ">
                <Icon icon="mdi:trash-can-outline" className="text-base" />
              </button>
            </div>
          </div>
        ))}
        {avatars.length === 0 && <p className="text-[12.5px] text-ink-tertiary">还没有数字人形象，先新建一个。</p>}
      </div>

      <div className="space-y-3 rounded-xl border border-hairline-subtle bg-surface p-4">
        <h3 className="text-[13px] font-semibold text-ink">新建数字人形象</h3>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="形象名称，如：我的口播分身"
          className="w-full rounded-lg border border-hairline-subtle px-3 py-2 text-[13px] outline-none focus:border-brand"
        />
        <button
          disabled={busy || !priced}
          onClick={() => inputRef.current?.click()}
          className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-hairline-subtle py-8 text-ink-tertiary disabled:opacity-40"
        >
          <Icon icon={cloning ? "mdi:loading" : "mdi:video-account"} className={`text-2xl ${cloning ? "animate-spin text-brand" : ""}`} />
          <span className="text-[13px]">{cloning ? "克隆中，请稍候…" : "上传无配音的场景视频（≤100MB）"}</span>
        </button>
        <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />

        {!priced && <p className="text-[12px] text-warning-ink">管理员尚未配置建形象价格，暂无法新建。</p>}
        {priced && estimate !== null && <p className="text-[12px] text-ink-tertiary">新建一次消耗 {estimate} 视频点。</p>}
      </div>
    </div>
  );
}
