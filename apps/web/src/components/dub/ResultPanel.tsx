import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { DownloadLinkDialog, type DownloadDialogState } from "../ui/DownloadLinkDialog";
import { generateProjectVideo, getProject, remixProject, type DubPricing, type DubProject } from "../../dubApi";
import { estimatePerUnit } from "../../dubWizard";

const POLL_MS = 3000;


export interface ResultPanelProps {
  readonly token: string;
  readonly projectId: string;
  readonly pricing: DubPricing | null;
  readonly audioDurationSec: number;
  readonly onErr: (msg: string) => void;
  readonly onBalanceRefresh?: () => Promise<void>;
}

export function ResultPanel({ token, projectId, pricing, audioDurationSec, onErr, onBalanceRefresh }: ResultPanelProps) {
  const [project, setProject] = useState<DubProject | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [dialog, setDialog] = useState<DownloadDialogState | null>(null);

  // 成片链接是对象存储直链，浏览器内 <a download> 常被跨域策略降级为跳转播放；
  // 统一走「复制链接到浏览器打开」的引导，并提示时效。
  const openDownload = (url: string, title: string) =>
    setDialog({
      title,
      links: [url],
      description: "复制链接到浏览器地址栏打开，即可保存视频到本地。",
    });

  const running = project?.stage === "generating" || project?.stage === "mixing";

  // 挂载即拉项目真实状态：否则刷新/返回本步时会误显示「开始成片」，导致二次下单扣费
  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const p = await getProject(token, projectId);
        if (!stop) setProject(p);
      } catch { /* 拉取失败按未开始处理 */ } finally {
        if (!stop) setLoaded(true);
      }
    })();
    return () => { stop = true; };
  }, [token, projectId]);

  useEffect(() => {
    if (!running) return;
    let stop = false;
    const tick = async () => {
      try {
        const p = await getProject(token, projectId);
        if (!stop) setProject(p);
      } catch { /* 轮询失败下轮重试 */ }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [running, token, projectId]);

  useEffect(() => {
    if (project?.stage === "done") void onBalanceRefresh?.();
  }, [project?.stage, onBalanceRefresh]);

  const priced = pricing?.videoSec.enabled ?? false;
  const estimate = pricing ? estimatePerUnit(pricing.videoSec, audioDurationSec) : null;

  const start = async () => {
    setStarting(true);
    try {
      await generateProjectVideo(token, projectId);
      setProject(await getProject(token, projectId));
    } catch (e) {
      onErr((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const remix = async () => {
    try {
      await remixProject(token, projectId);
      setProject(await getProject(token, projectId));
    } catch (e) {
      onErr((e as Error).message);
    }
  };

  const finalUrl = project?.finalVideoUrl;
  const rawUrl = project?.resultVideoUrl;

  return (
    <div className="space-y-5">
      {loaded && (!project || project.stage === "draft" || project.stage === "analyzed" || project.stage === "scripted" || project.stage === "voiced") ? (
        <div className="space-y-3 rounded-xl border border-gray-100 bg-white p-5">
          {!priced && <p className="text-[12px] text-amber-600">管理员尚未配置成片价格，暂无法生成。</p>}
          {priced && estimate !== null && (
            <p className="text-[12.5px] text-[#8a8a8f]">音频约 {audioDurationSec} 秒，预计消耗 {estimate} 视频点，按实际成片时长结算。</p>
          )}
          <button
            disabled={starting || !priced}
            onClick={start}
            className="rounded-lg bg-brand px-5 py-2.5 text-[13.5px] font-medium text-white disabled:opacity-40"
          >
            {starting ? "提交中…" : "开始成片"}
          </button>
        </div>
      ) : null}

      {running && (
        <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-5 text-[13px] text-ink-secondary">
          <Icon icon="mdi:loading" className="animate-spin text-lg text-brand" />
          正在对口型合成，通常需要几分钟，可稍后回来查看。
        </div>
      )}

      {project?.stage === "done" && finalUrl && (
        <div className="space-y-3 rounded-xl border border-gray-100 bg-white p-5">
          <video controls src={finalUrl} className="w-full rounded-lg" />
          <button
            type="button"
            onClick={() => openDownload(finalUrl, "下载成片")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white"
          >
            <Icon icon="mdi:download" /> 下载成片
          </button>

        </div>
      )}

      {dialog && <DownloadLinkDialog dialog={dialog} onClose={() => setDialog(null)} />}

      {project?.stage === "failed" && (
        <div className="space-y-3 rounded-xl border border-red-100 bg-red-50/50 p-5">
          <p className="text-[13px] text-red-600">{project.error ?? "成片失败"}</p>
          {rawUrl && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openDownload(rawUrl, "下载无配乐版本")}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-[13px] text-ink-secondary"
              >
                下载无配乐版本
              </button>
              <button onClick={() => void remix()} className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white">
                重新配乐
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
