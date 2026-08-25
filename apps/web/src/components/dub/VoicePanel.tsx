import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { generateTts, listPresetVoices, type DubPricing, type PresetVoice, type TtsMode } from "../../dubApi";
import { estimatePerUnit } from "../../dubWizard";

const CLONE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 发音风格预设：不让用户自己写。label 给人看，prompt 是真正传给 MiMo 的自然语言指令。
 * MiMo 的风格控制放在 user 消息里，一句自然语言即可生效（见 MiMo 文档「自然语言控制」）。
 */
const STYLE_PRESETS = [
  { id: "lively", label: "轻快活力", icon: "mdi:weather-sunny", prompt: "语调轻快上扬，语速稍快，声音明亮有活力，充满感染力。" },
  { id: "pro", label: "专业播报", icon: "mdi:microphone-variant", prompt: "平稳叙述，吐字清晰，节奏均匀，像专业新闻主播一样沉稳可信。" },
  { id: "emotional", label: "情绪饱满", icon: "mdi:heart-pulse", prompt: "情绪饱满，抑扬顿挫，重点词加重音，富有画面感与感染力。" },
  { id: "humor", label: "轻松幽默", icon: "mdi:emoticon-happy-outline", prompt: "轻松口语化，带点幽默和调侃，像朋友聊天一样自然随性。" },
  { id: "gentle", label: "温柔亲切", icon: "mdi:leaf", prompt: "温柔亲切，语速偏慢，气息柔和，娓娓道来，让人放松。" },
] as const;

export interface VoicePanelProps {
  readonly token: string;
  readonly text: string;
  readonly pricing: DubPricing | null;
  readonly audioUrl: string | null;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
  readonly onVoiced: (r: { audioUrl: string; objectKey: string; durationSec: number; mode: TtsMode }) => void;
  readonly onErr: (msg: string) => void;
}

/** FileReader 读出的是 `data:<mime>;base64,<payload>`，后端只要 payload 部分 */
function readBase64Payload(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("读取音频失败"));
    fr.onload = () => {
      const s = String(fr.result);
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.readAsDataURL(file);
  });
}

export function VoicePanel({ token, text, pricing, audioUrl, busy, setBusy, onVoiced, onErr }: VoicePanelProps) {
  const [mode, setMode] = useState<TtsMode>("preset");
  const [voices, setVoices] = useState<PresetVoice[]>([]);
  const [voice, setVoice] = useState("冰糖");
  const [description, setDescription] = useState("");
  const [styleId, setStyleId] = useState<string | null>(null);
  const [refFile, setRefFile] = useState<File | null>(null);
  const refInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listPresetVoices(token).then(setVoices).catch(() => setVoices([]));
  }, [token]);

  const priced = pricing?.ttsChar.enabled ?? false;
  const estimate = pricing ? estimatePerUnit(pricing.ttsChar, text.length) : null;

  const pickRef = (f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("audio/")) { onErr("仅支持音频文件"); return; }
    if (f.size > CLONE_MAX_BYTES) { onErr("参考音频不能超过 10MB"); return; }
    setRefFile(f);
  };

  const run = async () => {
    if (mode === "design" && !description.trim()) { onErr("请填写音色描述"); return; }
    if (mode === "clone" && !refFile) { onErr("请上传参考音频"); return; }
    setBusy(true);
    try {
      const input = {
        mode, text, format: "wav" as const,
        ...(mode === "preset" ? { voice } : {}),
        ...(mode === "design" ? { description: description.trim() } : {}),
        ...(mode === "clone" && refFile ? { refAudioBase64: await readBase64Payload(refFile), refAudioMime: refFile.type } : {}),
        ...(styleId && mode !== "design" ? { style: STYLE_PRESETS.find((p) => p.id === styleId)!.prompt } : {}),
      };
      const r = await generateTts(token, input);
      onVoiced({ ...r, mode });
    } catch (e) {
      onErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ id: TtsMode; label: string }> = [
    { id: "preset", label: "预置音色" },
    { id: "design", label: "文字描述音色" },
    { id: "clone", label: "上传音频复刻" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setMode(t.id)}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium ${mode === t.id ? "bg-brand text-white" : "bg-gray-100 text-ink-secondary"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mode === "preset" && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {voices.map((v) => (
            <button
              key={v.id}
              onClick={() => setVoice(v.id)}
              className={`flex items-center gap-2 rounded-xl border p-3 text-left ${voice === v.id ? "border-brand bg-brand/5" : "border-gray-200"}`}
            >
              <Icon icon={v.gender === "female" ? "mdi:face-woman-outline" : "mdi:face-man-outline"} className="text-lg text-brand" />
              <span>
                <span className="block text-[13px] font-medium text-ink">{v.label}</span>
                <span className="block text-[11px] text-ink-tertiary">{v.lang === "zh" ? "中文" : "英文"}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {mode === "design" && (
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="用文字描述你想要的音色，如：一位年迈的老先生，带北方口音，语速缓慢沉稳，嗓音略带沙哑与沧桑。"
          className="w-full rounded-xl border border-gray-200 p-3 text-[13.5px] outline-none focus:border-brand"
        />
      )}

      {mode === "clone" && (
        <div>
          <button
            onClick={() => refInput.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-8 text-ink-tertiary "
          >
            <Icon icon="mdi:microphone-outline" className="text-2xl" />
            <span className="text-[13px]">{refFile ? refFile.name : "上传参考音频复刻音色（≤10MB，mp3/wav）"}</span>
          </button>
          <input ref={refInput} type="file" accept="audio/*" className="hidden" onChange={(e) => pickRef(e.target.files?.[0] ?? null)} />
        </div>
      )}

      {mode !== "design" && (
        <section>
          <p className="mb-2 text-[12.5px] text-ink-secondary">发音风格（可选，再次点击取消）</p>
          <div className="flex flex-wrap gap-2">
            {STYLE_PRESETS.map((p) => {
              const on = styleId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setStyleId(on ? null : p.id)}
                  title={p.prompt}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors ${on ? "bg-brand text-white" : "bg-gray-100 text-ink-secondary "}`}
                >
                  <Icon icon={p.icon} className="text-[15px]" />
                  {p.label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {!priced && <p className="text-[12px] text-amber-600">管理员尚未配置配音价格，暂无法生成。</p>}
      {priced && estimate !== null && <p className="text-[12px] text-ink-tertiary">文案 {text.length} 字，预计消耗 {estimate} 算力点。</p>}

      <div className="flex items-center gap-3">
        <button
          disabled={busy || !priced || !text.trim()}
          onClick={run}
          className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {busy ? (<span className="flex items-center gap-1.5"><Icon icon="mdi:loading" className="animate-spin" />合成中…</span>) : audioUrl ? "重新生成" : "生成口播音频"}
        </button>
        {audioUrl && <audio controls src={audioUrl} className="h-9" />}
      </div>
    </div>
  );
}
