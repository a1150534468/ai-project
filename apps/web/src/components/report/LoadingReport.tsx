import { useEffect, useMemo, useState } from "react";

const MESSAGES = [
  "正在解析文档结构…",
  "提取关键数据指标…",
  "识别表格与数值…",
  "梳理内容脉络…",
  "规划报告版式…",
  "挑选合适的图表类型…",
  "绘制数据图表…",
  "生成核心结论…",
  "排布可视化模块…",
  "校对数据一致性…",
  "润色报告文案…",
  "组织章节层次…",
  "渲染图表动画…",
  "优化视觉呈现…",
  "整理摘要与要点…",
  "拼装自包含页面…",
  "注入图表引擎…",
  "做最后的排版微调…",
  "快好了，正在收尾…",
  "马上呈现你的报告…",
  "为数字添加滚动动效…",
  "让表格逐行灵动登场…",
];

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface LoadingReportProps {
  stage: "pending" | "running";
}

export function LoadingReport({ stage }: LoadingReportProps) {
  const list = useMemo(() => shuffle(MESSAGES), []);
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % list.length), 2500);
    return () => clearInterval(t);
  }, [list.length]);

  return (
    <div className="flex flex-col items-center justify-center py-20 gap-6">
      <div className="relative w-20 h-20">
        <div className="absolute inset-0 rounded-full border-4 border-brand/20" />
        <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-brand animate-spin" />
        <div className="absolute inset-2 rounded-full bg-brand/10 animate-pulse" />
      </div>
      <div className="text-xs font-medium text-brand bg-brand/5 px-3 py-1 rounded-full">
        {stage === "pending" ? "排队中" : "生成中"}
      </div>
      <div className="text-ink-secondary text-sm transition-opacity duration-500 min-h-[1.5rem]">
        {list[i]}
      </div>
      <p className="text-xs text-ink-tertiary">报告较复杂时可能需要一会儿，请勿关闭页面</p>
    </div>
  );
}
