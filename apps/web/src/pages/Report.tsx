import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useToast } from "../motion";
import { LoadingReport } from "../components/report/LoadingReport";
import { DownloadLinkDialog } from "../components/ui/DownloadLinkDialog";
import { listModels } from "../api";
import type { ReportTask } from "../workflowReportApi";
import {
  createTextReport,
  createFileReport,
  getReport,
  getReportHistory,
  getReportDownloadUrl,
} from "../workflowReportApi";

interface ReportPageProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => Promise<void>;
}

type Stage = "input" | "confirm" | "loading" | "preview";

/** 生成意图预设（可多选，组合成最终意图；不选则完全由 AI 自动决定）。 */
const INTENT_PRESETS: ReadonlyArray<{ key: string; label: string; text: string }> = [
  { key: "full", label: "全面详尽", text: "尽可能完整地呈现原文中的所有数据，不要遗漏关键信息" },
  { key: "summary", label: "提炼核心结论", text: "突出核心结论与关键要点" },
  { key: "trend", label: "趋势分析", text: "重点分析数据的趋势与变化" },
  { key: "compare", label: "对比分析", text: "重点做数据之间的对比分析" },
  { key: "exec", label: "面向管理层", text: "面向管理层，语言精炼、重点突出" },
  { key: "risk", label: "标注异常/风险", text: "标注异常值与潜在风险点" },
];

export default function Report({ token, onBalanceRefresh }: ReportPageProps) {
  const toast = useToast();

  // 全局状态
  const [stage, setStage] = useState<Stage>("input");
  const [error, setError] = useState("");
  const [models, setModels] = useState<{ model: string; displayName: string }[]>([]);

  // input 态
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [textInput, setText] = useState("");
  const [selectedPresets, setSelectedPresets] = useState<string[]>([]);
  // 由选中的预设组合出最终意图字符串（不选则为空 = 全自动）
  const intent = INTENT_PRESETS.filter((p) => selectedPresets.includes(p.key))
    .map((p) => p.text)
    .join("，");
  // 勾选「全面详尽」→ 后端不截断、大文件按分表分块，绝不漏数据
  const exhaustive = selectedPresets.includes("full");
  const [selectedModel, setSelectedModel] = useState("MiniMax-M3");
  const [history, setHistory] = useState<ReportTask[]>([]);

  // loading 态
  const [currentTaskId, setCurrentTaskId] = useState("");
  const [currentTask, setCurrentTask] = useState<ReportTask | null>(null);
  const pollIntervalRef = useCallback(() => {
    let intervalId: NodeJS.Timeout | null = null;
    return {
      start: (taskId: string) => {
        intervalId = setInterval(async () => {
          try {
            const task = await getReport(token, taskId);
            setCurrentTask(task);
            if (task.stage === "ready" || task.stage === "failed") {
              if (intervalId) clearInterval(intervalId);
              if (task.stage === "ready") {
                void (async () => {
                  const url = await getReportDownloadUrl(token, taskId);
                  setDownloadUrl(url);
                  setStage("preview");
                  await onBalanceRefresh?.().catch(() => undefined);
                })();
              } else {
                setError(task.error || "生成失败，请重试");
                setStage("input");
              }
            }
          } catch {
            /* 轮询瞬时错误忽略，下次继续 */
          }
        }, 2500);
      },
      stop: () => {
        if (intervalId) clearInterval(intervalId);
      },
    };
  }, [token, onBalanceRefresh]);

  const [poller, setPoller] = useState(pollIntervalRef());
  const [downloadUrl, setDownloadUrl] = useState("");

  // preview 态
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);

  // 初始化：加载模型列表和历史
  useEffect(() => {
    const init = async () => {
      try {
        const modelsList = await listModels();
        setModels(modelsList);
        // 尝试找 MiniMax-M3，否则选第一个
        const hasM3 = modelsList.some((m) => m.model === "MiniMax-M3");
        setSelectedModel(hasM3 ? "MiniMax-M3" : modelsList[0]?.model || "");
      } catch {
        /* 模型列表加载失败则维持默认，不打断页面 */
      }

      try {
        const hist = await getReportHistory(token);
        setHistory(hist);
      } catch {
        /* 历史加载失败静默降级 */
      }
    };
    void init();
  }, [token]);

  // 清理轮询（组件卸载或切换阶段时）
  useEffect(() => {
    return () => {
      poller.stop();
    };
  }, [poller]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.currentTarget.files;
    if (files && files.length > 0) {
      setSelectedFile(files[0]);
      setError("");
    }
  };

  const handlePasteText = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.currentTarget.value);
    setError("");
  };

  const togglePreset = (key: string) =>
    setSelectedPresets((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );

  const hasInput = selectedFile !== null || textInput.trim().length > 0;

  const handleNext = () => {
    if (!hasInput) {
      setError("请选择文件或输入文本");
      return;
    }
    setError("");
    setStage("confirm");
  };

  const handleStartGenerate = async () => {
    try {
      setError("");
      setStage("loading");
      let taskId: string;
      if (selectedFile) {
        taskId = await createFileReport(token, selectedFile, intent, selectedModel, exhaustive);
      } else {
        taskId = await createTextReport(token, {
          text: textInput,
          intent,
          model: selectedModel,
          exhaustive,
        });
      }
      setCurrentTaskId(taskId);
      setCurrentTask({
        id: taskId,
        stage: "pending",
        sourceType: selectedFile ? "file" : "text",
        sourceName: selectedFile?.name ?? null,
        model: selectedModel,
        htmlKey: null,
        truncated: false,
        error: null,
        createdAt: new Date().toISOString(),
      });

      // 开始轮询
      const newPoller = pollIntervalRef();
      setPoller(newPoller);
      newPoller.start(taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动生成失败");
      setStage("confirm");
    }
  };

  const handleBack = () => {
    poller.stop();
    setStage("input");
    setError("");
  };

  const handleReset = () => {
    poller.stop();
    setSelectedFile(null);
    setText("");
    setSelectedPresets([]);
    setCurrentTaskId("");
    setCurrentTask(null);
    setDownloadUrl("");
    setShowDownloadDialog(false);
    setError("");
    setStage("input");
  };

  const handleHistoryClick = async (historyItem: ReportTask) => {
    if (historyItem.stage !== "ready") return;
    try {
      const url = await getReportDownloadUrl(token, historyItem.id);
      setDownloadUrl(url);
      setCurrentTask(historyItem);
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载报告失败");
    }
  };

  const handleDownload = () => {
    setShowDownloadDialog(true);
  };

  // ===== 渲染各阶段 =====

  if (stage === "loading") {
    return (
      <div className="min-h-screen bg-surface-muted">
        <div className="container mx-auto px-4 py-8">
          <LoadingReport stage={currentTask?.stage === "pending" ? "pending" : "running"} />
        </div>
      </div>
    );
  }

  if (stage === "confirm") {
    const modelDisplay = models.find((m) => m.model === selectedModel)?.displayName || selectedModel;
    return (
      <div className="min-h-screen bg-surface-muted">
        <div className="container mx-auto px-4 py-12">
          {error && (
            <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 border border-red-200">
              {error}
            </div>
          )}

          <div className="mx-auto max-w-2xl">
            <h1 className="text-3xl font-bold text-slate-900">确认信息</h1>
            <p className="mt-2 text-slate-600">检查您的报告生成配置</p>

            <div className="mt-8 space-y-6">
              <div className="rounded-xl border border-slate-200 bg-white p-6">
                <h3 className="font-semibold text-slate-900">选择的模型</h3>
                <div className="mt-2 flex items-center gap-2">
                  <Icon icon="mdi:cube-outline" className="text-brand" />
                  <span className="text-slate-700">{modelDisplay}</span>
                </div>
              </div>

              {exhaustive && (
                <div className="rounded-xl border border-brand/30 bg-brand-soft p-4">
                  <div className="flex gap-3">
                    <Icon icon="mdi:playlist-check" className="text-brand-ink flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-brand-ink">
                      <p className="font-semibold mb-1">全面详尽模式</p>
                      <ul className="list-disc list-inside space-y-1 text-xs">
                        <li>完整读取所有分表数据，绝不遗漏</li>
                        <li>大文件会自动分多段生成（消耗更多算力点），报告较长并带顶部目录导航</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex gap-3">
                  <Icon icon="mdi:information" className="text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="text-sm text-amber-800">
                    <p className="font-semibold mb-1">计费说明</p>
                    <ul className="list-disc list-inside space-y-1 text-xs">
                      <li>按所选模型计费</li>
                      <li>输出按实际生成量计费</li>
                      {!exhaustive && <li>文本过长会自动截取前段</li>}
                      <li>生成失败不扣除未消耗部分</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleBack}
                  className="flex-1 rounded-lg border border-slate-300 px-4 py-3 font-semibold text-slate-700 transition-colors"
                >
                  <Icon icon="mdi:arrow-left" className="inline mr-2" />
                  返回
                </button>
                <button
                  onClick={handleStartGenerate}
                  className="flex-1 rounded-lg bg-brand px-4 py-3 font-semibold text-white transition-colors"
                >
                  <Icon icon="mdi:play-circle-outline" className="inline mr-2" />
                  开始生成
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (stage === "preview") {
    return (
      <div className="min-h-screen bg-surface-muted">
        {showDownloadDialog && (
          <DownloadLinkDialog
            dialog={{ title: "下载报告", links: [downloadUrl] }}
            onClose={() => setShowDownloadDialog(false)}
          />
        )}

        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold text-slate-900">报告预览</h1>
              <p className="mt-1 text-slate-600">
                来源: {currentTask?.sourceName || (currentTask?.sourceType === "text" ? "粘贴文本" : "文件")}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleDownload}
                className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700 transition-colors flex items-center gap-2"
              >
                <Icon icon="mdi:download" />
                下载 HTML
              </button>
              <button
                onClick={handleReset}
                className="rounded-lg bg-brand px-4 py-2 font-semibold text-white transition-colors flex items-center gap-2"
              >
                <Icon icon="mdi:plus" />
                再做一份
              </button>
            </div>
          </div>

          <iframe
            title="report-preview"
            src={downloadUrl}
            sandbox="allow-scripts"
            className="w-full h-[70vh] border border-slate-200 rounded-xl bg-white"
          />
        </div>
      </div>
    );
  }

  // === input 态 ===
  return (
    <div className="min-h-screen bg-surface-muted">
      <div className="container mx-auto px-4 py-12">
        {error && (
          <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 border border-red-200">
            {error}
          </div>
        )}

        <div className="mx-auto max-w-3xl">
          <div className="mb-12">
            <h1 className="text-3xl font-bold text-slate-900">AI 智能报告</h1>
            <p className="mt-2 text-slate-600">上传或粘贴文本生成专业的数据报告</p>
          </div>

          <div className="space-y-6">
            {/* 文件选择 */}
            <div className="rounded-xl border-2 border-dashed border-slate-300 bg-white p-8">
              <label className="flex flex-col items-center gap-4 cursor-pointer">
                <Icon icon="mdi:cloud-upload-outline" className="text-3xl text-brand" />
                <div className="text-center">
                  <p className="font-semibold text-slate-900">选择文件上传</p>
                  <p className="text-xs text-slate-500 mt-1">
                    支持 txt, md, csv, pdf, docx, xlsx, xls, pptx
                  </p>
                </div>
                <input
                  type="file"
                  accept=".txt,.md,.csv,.pdf,.docx,.xlsx,.xls,.pptx"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>
              {selectedFile && (
                <div className="mt-4 flex items-center gap-2 bg-brand/5 rounded-lg p-3">
                  <Icon icon="mdi:file-check" className="text-brand" />
                  <span className="text-sm font-medium text-slate-700">{selectedFile.name}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedFile(null)}
                    className="ml-auto text-slate-400 "
                  >
                    <Icon icon="mdi:close" />
                  </button>
                </div>
              )}
            </div>

            <div className="relative">
              <div className="absolute inset-x-0 top-1/2 border-t border-slate-300" />
              <div className="relative flex justify-center">
                <span className="bg-white px-2 text-sm font-medium text-slate-500">或者</span>
              </div>
            </div>

            {/* 文本粘贴 */}
            <div>
              <label className="block text-sm font-semibold text-slate-900 mb-2">粘贴长文字</label>
              <textarea
                value={textInput}
                onChange={handlePasteText}
                placeholder="粘贴你的数据、文本或报告内容…"
                rows={6}
                className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm text-slate-900 placeholder-slate-500 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>

            {/* 意图（可选，多选预设） */}
            <div>
              <label className="block text-sm font-semibold text-slate-900 mb-2">
                生成意图（可选，可多选）
              </label>
              <div className="flex flex-wrap gap-2">
                {INTENT_PRESETS.map((p) => {
                  const active = selectedPresets.includes(p.key);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => togglePreset(p.key)}
                      className={
                        active
                          ? "rounded-full border border-brand bg-brand/10 px-4 py-2 text-sm font-medium text-brand transition-colors"
                          : "rounded-full border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 transition-colors"
                      }
                    >
                      {active && <Icon icon="mdi:check" className="inline-block mr-1 -mt-0.5" />}
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-slate-400">不选则由 AI 自动决定报告的重点与形式。</p>
            </div>

            {/* 模型选择 */}
            <div>
              <label className="block text-sm font-semibold text-slate-900 mb-2">选择模型</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.currentTarget.value)}
                className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm text-slate-900 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand bg-white cursor-pointer"
              >
                {models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </div>

            {/* 下一步按钮 */}
            <button
              onClick={handleNext}
              disabled={!hasInput}
              className="w-full rounded-lg bg-brand px-4 py-3 font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              <Icon icon="mdi:arrow-right" />
              下一步
            </button>
          </div>

          {/* 历史列表 */}
          {history.length > 0 && (
            <div className="mt-12 pt-8 border-t border-slate-200">
              <h2 className="text-lg font-semibold text-slate-900 mb-4">最近报告</h2>
              <div className="space-y-2">
                {history.map((item) => {
                  const canOpen = item.stage === "ready";
                  const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
                    ready: { bg: "bg-brand-soft", text: "text-brand-ink", label: "已完成" },
                    failed: { bg: "bg-red-50", text: "text-red-600", label: "失败" },
                    running: { bg: "bg-blue-50", text: "text-blue-600", label: "进行中" },
                    pending: { bg: "bg-yellow-50", text: "text-yellow-600", label: "排队中" },
                  };
                  const config = statusConfig[item.stage] || statusConfig.pending;

                  return (
                    <button
                      key={item.id}
                      onClick={() => handleHistoryClick(item)}
                      disabled={!canOpen}
                      className={`w-full rounded-lg border border-slate-200 px-4 py-3 text-left transition-colors ${
                        canOpen
                          ? " cursor-pointer"
                          : "opacity-60 cursor-not-allowed"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-slate-900">
                            {item.sourceName || (item.sourceType === "text" ? "粘贴文本" : "文件")}
                          </p>
                          <p className="text-xs text-slate-500">
                            {new Date(item.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <span className={`text-xs font-semibold rounded-full px-3 py-1 ${config.bg} ${config.text}`}>
                          {config.label}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
