import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { listKb } from "../../api";
import { rewriteScript } from "../../dubApi";

export interface RewritePanelProps {
  readonly token: string;
  readonly spokenScript: string;
  readonly script: string;
  readonly highlights: readonly string[];
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
  readonly onScriptChange: (v: string) => void;
  readonly onKbIdsChange: (ids: string[]) => void;
  readonly onErr: (msg: string) => void;
}

export function RewritePanel({ token, spokenScript, script, highlights, busy, setBusy, onScriptChange, onKbIdsChange, onErr }: RewritePanelProps) {
  const [kbs, setKbs] = useState<Array<{ id: string; name: string }>>([]);
  const [kbIds, setKbIds] = useState<string[]>([]);
  const [injectHighlights, setInjectHighlights] = useState(highlights.length > 0);
  const [style, setStyle] = useState("");

  useEffect(() => {
    listKb(token).then((r) => setKbs(r.map((k) => ({ id: k.id, name: k.name })))).catch(() => setKbs([]));
  }, [token]);

  const toggleKb = (id: string) => {
    const next = kbIds.includes(id) ? kbIds.filter((k) => k !== id) : [...kbIds, id];
    setKbIds(next);
    onKbIdsChange(next);
  };

  const run = async () => {
    setBusy(true);
    try {
      const s = await rewriteScript(token, {
        text: spokenScript,
        kbIds,
        injectHighlights,
        highlights: injectHighlights ? [...highlights] : undefined,
        style: style.trim() || undefined,
      });
      onScriptChange(s);
    } catch (e) {
      onErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-gray-100 bg-surface p-4">
          <h3 className="mb-2 text-[13px] font-semibold text-ink">原始口播文稿</h3>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-[13px] leading-relaxed text-ink-secondary">{spokenScript || "—"}</pre>
        </section>

        <section className="rounded-xl border border-gray-100 bg-surface p-4">
          <h3 className="mb-2 text-[13px] font-semibold text-ink">洗稿结果（可编辑）</h3>
          <textarea
            value={script}
            onChange={(e) => onScriptChange(e.target.value)}
            rows={12}
            placeholder="点击「洗稿」生成改写文案；也可直接跳过，沿用原稿。"
            className="w-full rounded-lg border border-gray-200 p-3 text-[13.5px] leading-relaxed outline-none focus:border-brand"
          />
        </section>
      </div>

      <div className="space-y-3 rounded-xl border border-gray-100 bg-surface p-4">
        <div>
          <p className="mb-2 text-[12.5px] font-medium text-ink-secondary">挂载知识库（可选，改写时可引用其中事实）</p>
          {kbs.length === 0 ? (
            <p className="text-[12px] text-ink-tertiary">暂无知识库</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {kbs.map((k) => (
                <button
                  key={k.id}
                  onClick={() => toggleKb(k.id)}
                  className={`rounded-full px-3 py-1 text-[12px] ${kbIds.includes(k.id) ? "bg-brand text-white" : "bg-gray-100 text-ink-secondary"}`}
                >
                  {k.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {highlights.length > 0 && (
          <label className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
            <input type="checkbox" checked={injectHighlights} onChange={(e) => setInjectHighlights(e.target.checked)} />
            改写时必须保留亮点卖点（{highlights.join("、")}）
          </label>
        )}

        <input
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          placeholder="风格要求（可选），如：活泼、口语化、带点幽默"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-brand"
        />

        <button
          disabled={busy || !spokenScript.trim()}
          onClick={run}
          className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {busy ? (<span className="flex items-center gap-1.5"><Icon icon="mdi:loading" className="animate-spin" />洗稿中…</span>) : "洗稿"}
        </button>
        <p className="text-[11.5px] text-ink-tertiary">洗稿按模型用量计费（算力点）。也可跳过本步，直接用原稿配音。</p>
      </div>
    </div>
  );
}
