/** 表情包工坊：描述角色/上传参考图 → 选模板 → 一键生成 16 张成套贴纸。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createStickerPack,
  deleteStickerPack,
  getStickerPack,
  listStickerPacks,
  listStickerPresets,
  retryStickerPack,
  runStickerPack,
  uploadStickerReference,
  type StickerPack,
  type StickerPackDetail,
  type StickerPreset,
} from "../../stickerApi";
import { cx } from "../ui/cx";

const POLL_INTERVAL_MS = 5000;

function statusLabel(status: string): string {
  switch (status) {
    case "queued": return "排队中";
    case "running": return "生成中";
    case "completed": return "已完成";
    case "failed": return "失败";
    default: return status;
  }
}

function downloadImage(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  // 跨域 S3 URL 下 download 属性会被浏览器忽略，加 target 兜底避免当前页被导航走
  anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function StickerStudio({ token }: { readonly token: string }): React.ReactElement {
  const [packs, setPacks] = useState<readonly StickerPack[]>([]);
  const [activePackId, setActivePackId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StickerPackDetail | null>(null);
  const [presets, setPresets] = useState<readonly StickerPreset[]>([]);
  const [name, setName] = useState("");
  const [characterPrompt, setCharacterPrompt] = useState("");
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [selectedPresets, setSelectedPresets] = useState<ReadonlySet<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  // 详情请求序号 + 当前选中 pack：丢弃乱序/过期响应，避免 A→B 切换后 A 的晚到响应覆盖 B
  const detailReqId = useRef(0);
  const activePackIdRef = useRef<string | null>(null);
  useEffect(() => { activePackIdRef.current = activePackId; }, [activePackId]);

  const refreshPacks = useCallback(async () => {
    try {
      const list = await listStickerPacks(token);
      setPacks(list);
      if (!activePackId && list.length > 0) setActivePackId(list[0].id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "加载失败");
    }
  }, [token, activePackId]);

  const refreshDetail = useCallback(async (packId: string) => {
    const reqId = ++detailReqId.current;
    try {
      const loaded = await getStickerPack(token, packId);
      if (detailReqId.current !== reqId) return;
      if (activePackIdRef.current !== packId) return;
      setDetail(loaded);
    } catch (failure) {
      if (detailReqId.current !== reqId) return;
      setError(failure instanceof Error ? failure.message : "加载详情失败");
    }
  }, [token]);

  // 模板列表独立于 pack 获取：新用户还没有任何 pack 时也能选模板建首单
  useEffect(() => {
    let cancelled = false;
    listStickerPresets(token)
      .then((list) => {
        if (cancelled) return;
        setPresets(list);
        setSelectedPresets((current) => current ?? new Set(list.map((preset) => preset.key)));
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "加载模板失败");
      });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => { void refreshPacks(); }, [refreshPacks]);

  useEffect(() => {
    if (!activePackId) { setDetail(null); return; }
    void refreshDetail(activePackId);
  }, [activePackId, refreshDetail]);

  // 活跃任务 5 秒轮询
  useEffect(() => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    const active = detail?.pack;
    if (active && (active.status === "queued" || active.status === "running")) {
      pollTimer.current = window.setInterval(() => { void refreshDetail(active.id); void refreshPacks(); }, POLL_INTERVAL_MS);
    }
    return () => { if (pollTimer.current) window.clearInterval(pollTimer.current); };
  }, [detail?.pack?.status, detail?.pack?.id, refreshDetail, refreshPacks]);

  const togglePreset = (key: string): void => {
    setSelectedPresets((current) => {
      const next = new Set(current ?? []);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleCreate = async (): Promise<void> => {
    if (!characterPrompt.trim() && !referenceFile) {
      setError("请填写角色描述，或上传一张参考图");
      return;
    }
    const presets = [...(selectedPresets ?? [])];
    if (presets.length === 0) { setError("请至少选择一个表情模板"); return; }
    setBusy(true);
    setError(null);
    try {
      let referenceObjectKey: string | null = null;
      if (referenceFile) referenceObjectKey = await uploadStickerReference(token, referenceFile);
      const pack = await createStickerPack(token, {
        name: name.trim() || undefined,
        characterPrompt: characterPrompt.trim(),
        referenceObjectKey,
        presetKeys: presets,
      });
      await runStickerPack(token, pack.id);
      setReferenceFile(null);
      await refreshPacks();
      setActivePackId(pack.id);
      await refreshDetail(pack.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async (packId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await retryStickerPack(token, packId);
      await runStickerPack(token, packId);
      await refreshDetail(packId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "重试失败");
    } finally {
      setBusy(false);
    }
  };

  // queued 任务的启动入口：/run 是 fire-and-forget，若那次触发丢失，任务会卡在 queued
  const handleStart = async (packId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await runStickerPack(token, packId);
      await refreshDetail(packId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "启动失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (packId: string): Promise<void> => {
    if (!window.confirm("确定删除这个表情包任务吗？已生成的贴纸会保留在素材库。")) return;
    try {
      await deleteStickerPack(token, packId);
      if (activePackId === packId) { setActivePackId(null); setDetail(null); }
      await refreshPacks();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "删除失败");
    }
  };

  const activePack = detail?.pack;
  const total = activePack?.presetKeys.length ?? 0;
  const done = (activePack?.completedCount ?? 0) + (activePack?.failedCount ?? 0);

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* 左：创建面板 */}
      <section className="w-full shrink-0 rounded-[14px] border border-hairline-subtle bg-surface p-5 lg:w-[380px]">
        <h2 className="text-base font-bold text-ink">新建表情包</h2>
        <p className="mt-1 text-xs leading-5 text-ink-secondary">
          一套默认 16 张，每张约消耗 1 次生图调用（含主形象约 17 次）。生成中请勿关闭页面。
        </p>

        <label className="mt-4 block text-sm font-semibold text-ink">套装名称（可选）</label>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：橘猫日常"
          className="mt-1 w-full rounded-lg border border-hairline-subtle bg-surface-muted px-3 py-2 text-sm text-ink" />

        <label className="mt-4 block text-sm font-semibold text-ink">角色描述</label>
        <textarea value={characterPrompt} onChange={(event) => setCharacterPrompt(event.target.value)}
          placeholder="例如：一只圆滚滚的橘猫，戴着红色小领结" rows={3}
          className="mt-1 w-full rounded-lg border border-hairline-subtle bg-surface-muted px-3 py-2 text-sm text-ink" />

        <label className="mt-4 block text-sm font-semibold text-ink">参考图（可选，优先于文字描述）</label>
        <input type="file" accept="image/png,image/jpeg,image/webp"
          onChange={(event) => setReferenceFile(event.target.files?.[0] ?? null)}
          className="mt-1 w-full text-sm text-ink-secondary" />
        {referenceFile && <p className="mt-1 text-xs text-ink-secondary">已选择：{referenceFile.name}</p>}

        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink">表情模板（{selectedPresets?.size ?? presets.length}/{presets.length}）</span>
          <button type="button" onClick={() => setSelectedPresets(new Set(presets.map((preset) => preset.key)))}
            className="text-xs text-brand-ink">全选</button>
        </div>
        <div className="mt-2 flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {presets.map((preset) => {
            const selected = selectedPresets?.has(preset.key) ?? true;
            return (
              <button key={preset.key} type="button" onClick={() => togglePreset(preset.key)}
                className={cx(
                  "rounded-full border px-3 py-1 text-xs font-semibold",
                  selected ? "border-brand bg-brand text-white" : "border-hairline-subtle bg-surface-muted text-ink-secondary",
                )}>
                {preset.label}
              </button>
            );
          })}
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button type="button" onClick={handleCreate} disabled={busy}
          className="mt-4 w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
          {busy ? "处理中…" : "一键生成表情包"}
        </button>
      </section>

      {/* 右：任务与结果 */}
      <section className="min-w-0 flex-1">
        {packs.length > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto">
            {packs.map((pack) => (
              <button key={pack.id} type="button" onClick={() => setActivePackId(pack.id)}
                className={cx(
                  "flex-none rounded-lg border px-3 py-2 text-left text-xs",
                  activePackId === pack.id ? "border-brand bg-surface" : "border-hairline-subtle bg-surface-muted",
                )}>
                <span className="block max-w-32 truncate font-semibold text-ink">{pack.name}</span>
                <span className="text-ink-tertiary">{statusLabel(pack.status)}</span>
              </button>
            ))}
          </div>
        )}

        {!activePack ? (
          <div className="rounded-[14px] border border-hairline-subtle bg-surface p-10 text-center text-sm text-ink-secondary">
            还没有表情包任务，在左侧创建一个吧
          </div>
        ) : (
          <div className="rounded-[14px] border border-hairline-subtle bg-surface p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-ink">{activePack.name}</h2>
                <p className="mt-1 text-xs text-ink-secondary">
                  {statusLabel(activePack.status)} · {done}/{total} 张
                  {activePack.failedCount > 0 && <span className="text-red-600">（{activePack.failedCount} 张失败）</span>}
                </p>
                {(activePack.status === "queued" || activePack.status === "running") && total > 0 && (
                  <div className="mt-2 h-2 w-64 overflow-hidden rounded-full bg-surface-muted">
                    <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.round((done / total) * 100)}%` }} />
                  </div>
                )}
                {activePack.error && <p className="mt-2 text-xs text-red-600">{activePack.error}</p>}
              </div>
              <div className="flex gap-2">
                {activePack.status === "queued" && (
                  <button type="button" onClick={() => handleStart(activePack.id)} disabled={busy}
                    className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                    开始生成
                  </button>
                )}
                {activePack.status === "failed" && (
                  <button type="button" onClick={() => handleRetry(activePack.id)} disabled={busy}
                    className="rounded-lg border border-hairline-subtle px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-50">
                    重试
                  </button>
                )}
                {(activePack.status === "completed" || activePack.status === "failed") && (
                  <button type="button" onClick={() => handleDelete(activePack.id)}
                    className="rounded-lg border border-hairline-subtle px-3 py-1.5 text-xs font-semibold text-red-600">
                    删除
                  </button>
                )}
              </div>
            </div>

            {detail?.baseAsset && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold text-ink-secondary">主形象</p>
                <img src={detail.baseAsset.thumbnailUrl} alt="主形象" className="h-24 w-24 rounded-xl border border-hairline-subtle object-cover" />
              </div>
            )}

            {detail && detail.stickers.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold text-ink-secondary">贴纸（{detail.stickers.length}）</p>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                  {detail.stickers.map((sticker) => {
                    // requestIndex 对应 pack.presetKeys 的顺序，不是全量模板数组的下标
                    const presetKey = detail.pack.presetKeys[sticker.requestIndex];
                    const preset = presets.find((item) => item.key === presetKey);
                    return (
                      <button key={sticker.id} type="button" title={preset?.label ?? ""}
                        onClick={() => downloadImage(sticker.originalUrl, `sticker-${preset?.key ?? sticker.requestIndex}.png`)}
                        className="group relative overflow-hidden rounded-xl border border-hairline-subtle">
                        <img src={sticker.thumbnailUrl} alt={preset?.label ?? "贴纸"} className="aspect-square w-full object-cover" />
                        <span className="absolute inset-x-0 bottom-0 bg-black/50 px-1 py-0.5 text-center text-[10px] text-white opacity-0 group-hover:opacity-100">
                          {preset?.label ?? ""} · 下载
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-ink-tertiary">点击任意贴纸下载 PNG（240px 以上，可直接用于微信表情包提交）</p>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
