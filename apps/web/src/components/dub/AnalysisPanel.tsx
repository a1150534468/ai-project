import type { DubAnalysis } from "../../dubApi";

export interface AnalysisPanelProps {
  readonly analysis: DubAnalysis;
  readonly spokenScript: string;
  readonly onSpokenScriptChange: (v: string) => void;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-100 bg-white p-4">
      <h3 className="mb-2 text-[13px] font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

export function AnalysisPanel({ analysis, spokenScript, onSpokenScriptChange }: AnalysisPanelProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="口播文稿（可编辑，将用于洗稿）">
        <textarea
          value={spokenScript}
          onChange={(e) => onSpokenScriptChange(e.target.value)}
          rows={12}
          className="w-full rounded-lg border border-gray-200 p-3 text-[13.5px] leading-relaxed outline-none focus:border-brand"
        />
      </Card>

      <div className="space-y-4">
        <Card title="分镜脚本">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-secondary">
            {analysis.shotScript || "—"}
          </pre>
        </Card>

        <Card title="结构拆解">
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-secondary">
            {analysis.structure || "—"}
          </pre>
        </Card>

        <Card title="亮点卖点">
          {analysis.highlights.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {analysis.highlights.map((h) => (
                <span key={h} className="rounded-full bg-brand/10 px-2.5 py-1 text-[12px] text-brand">{h}</span>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-[#8a8a8f]">—</p>
          )}
        </Card>
      </div>
    </div>
  );
}
