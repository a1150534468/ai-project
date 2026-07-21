import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { listBgmPresets, uploadBgm, type DubBgm } from "../../dubApi";

const MAX_BYTES = 20 * 1024 * 1024;

export interface BgmPanelProps {
  readonly token: string;
  readonly bgmPresetId: string | null;
  readonly bgmObjectKey: string | null;
  readonly bgmVolume: number;
  readonly onChange: (v: { bgmPresetId: string | null; bgmObjectKey: string | null; bgmVolume: number }) => void;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
  readonly onErr: (msg: string) => void;
}

export function BgmPanel({ token, bgmPresetId, bgmObjectKey, bgmVolume, onChange, busy, setBusy, onErr }: BgmPanelProps) {
  const [presets, setPresets] = useState<DubBgm[]>([]);
  const [uploadedName, setUploadedName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listBgmPresets(token).then(setPresets).catch(() => setPresets([]));
  }, [token]);

  const none = !bgmPresetId && !bgmObjectKey;

  const upload = async (f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("audio/")) { onErr("仅支持音频文件"); return; }
    if (f.size > MAX_BYTES) { onErr("配乐不能超过 20MB"); return; }
    setBusy(true);
    try {
      const r = await uploadBgm(token, f);
      setUploadedName(f.name);
      onChange({ bgmPresetId: null, bgmObjectKey: r.objectKey, bgmVolume });
    } catch (e) {
      onErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <button
        onClick={() => onChange({ bgmPresetId: null, bgmObjectKey: null, bgmVolume })}
        className={`w-full rounded-xl border p-3 text-left text-[13px] ${none ? "border-brand bg-brand/5" : "border-gray-200"}`}
      >
        <Icon icon="mdi:music-note-off-outline" className="mr-2 inline text-lg text-brand" />
        不加配乐
      </button>

      <section>
        <h3 className="mb-2 text-[13px] font-semibold text-[#1d1d1f]">预制配乐</h3>
        {presets.length === 0 ? (
          <p className="text-[12.5px] text-[#b6b6bd]">暂无预制配乐</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {presets.map((b) => (
              <div
                key={b.id}
                className={`flex items-center gap-3 rounded-xl border p-3 ${bgmPresetId === b.id ? "border-brand bg-brand/5" : "border-gray-200"}`}
              >
                <button onClick={() => onChange({ bgmPresetId: b.id, bgmObjectKey: null, bgmVolume })} className="flex-1 text-left text-[13px] font-medium text-[#1d1d1f]">
                  {b.title}
                </button>
                <audio controls src={b.url} className="h-8 w-40" />
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-semibold text-[#1d1d1f]">上传自己的配乐</h3>
        <button
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className={`flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed py-8 text-[#8a8a8f] disabled:opacity-40 ${bgmObjectKey ? "border-brand/50" : "border-gray-200"}`}
        >
          <Icon icon="mdi:music-note-plus" className="text-2xl" />
          <span className="text-[13px]">{bgmObjectKey ? `已上传：${uploadedName || "自定义配乐"}` : "点击上传配乐（≤20MB，mp3/wav）"}</span>
        </button>
        <input ref={inputRef} type="file" accept="audio/*" className="hidden" onChange={(e) => void upload(e.target.files?.[0] ?? null)} />
      </section>

      {!none && (
        <section>
          <label className="mb-2 block text-[12.5px] text-[#5a5a60]">配乐音量：{Math.round(bgmVolume * 100)}%（人声音量不变）</label>
          <input
            type="range" min={0} max={1} step={0.05} value={bgmVolume}
            onChange={(e) => onChange({ bgmPresetId, bgmObjectKey, bgmVolume: Number(e.target.value) })}
            className="w-full accent-brand"
          />
        </section>
      )}
    </div>
  );
}
