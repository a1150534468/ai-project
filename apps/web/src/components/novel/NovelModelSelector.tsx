import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { listModels } from "../../api";

interface NovelModelOption {
  readonly model: string;
  readonly displayName: string;
}

export function NovelModelSelector({
  value,
  saving,
  onChange,
}: {
  readonly value: string;
  readonly saving: boolean;
  readonly onChange: (model: string, displayName: string) => void;
}) {
  const [models, setModels] = useState<readonly NovelModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void listModels()
      .then((rows) => {
        if (!cancelled) setModels(rows);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "模型列表加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selectedKnown = useMemo(() => !value || models.some((model) => model.model === value), [models, value]);
  const title = error || "项目默认写作模型；提示词节点单独绑定的模型优先。切换仅影响尚未开始的生成任务，当前任务不受影响";

  return (
    <label className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-surface-subtle px-2.5 text-[10px] font-semibold text-ink-tertiary transition focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/10" title={title}>
      <Icon icon={saving ? "mdi:loading" : error ? "mdi:alert-circle-outline" : "mdi:brain"} className={`text-sm ${error ? "text-danger-ink" : "text-brand-ink"} ${saving ? "animate-spin" : ""}`} />
      <span className="hidden 2xl:inline">写作模型</span>
      <select
        aria-label="写作模型"
        value={value}
        disabled={saving || loading || Boolean(error)}
        onChange={(event) => {
          const next = event.currentTarget.value;
          const selected = models.find((model) => model.model === next);
          onChange(next, selected?.displayName || selected?.model || "系统默认");
        }}
        className="max-w-44 border-0 bg-transparent p-0 text-xs font-semibold text-ink outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">系统默认</option>
        {!selectedKnown && <option value={value}>{value}（已不可选）</option>}
        {models.map((model) => (
          <option key={model.model} value={model.model}>
            {model.displayName || model.model}
          </option>
        ))}
      </select>
    </label>
  );
}
