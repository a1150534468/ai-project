import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useToast } from "../motion";
import { StepRail } from "../components/dub/StepRail";
import { BusyOverlay } from "../components/dub/BusyOverlay";
import { HistorySidebar } from "../components/dub/HistorySidebar";
import { SourcePanel } from "../components/dub/SourcePanel";
import { AnalysisPanel } from "../components/dub/AnalysisPanel";
import { RewritePanel } from "../components/dub/RewritePanel";
import { VoicePanel } from "../components/dub/VoicePanel";
import { AvatarPanel } from "../components/dub/AvatarPanel";
import { BgmPanel } from "../components/dub/BgmPanel";
import { ResultPanel } from "../components/dub/ResultPanel";
import { canLeaveStage, effectiveScript, nextStage, prevStage, stageIndex, STAGES, type StageId } from "../dubWizard";
import {
  createProject, deleteProject, getDubPricing, getProject, listProjects, patchProject,
  type DubAnalysis, type DubPricing, type DubProject,
} from "../dubApi";

interface DigitalHumanProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => Promise<void>;
}

export default function DigitalHuman({ token, onBalanceRefresh }: DigitalHumanProps) {
  const { show } = useToast();
  const [projects, setProjects] = useState<DubProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [pricing, setPricing] = useState<DubPricing | null>(null);
  const [stage, setStage] = useState<StageId>("source");
  const [busy, setBusy] = useState(false);

  const [analysis, setAnalysis] = useState<DubAnalysis | null>(null);
  const [spokenScript, setSpokenScript] = useState("");
  const [script, setScript] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioObjectKey, setAudioObjectKey] = useState<string | null>(null);
  const [audioDurationSec, setAudioDurationSec] = useState(0);
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [bgmPresetId, setBgmPresetId] = useState<string | null>(null);
  const [bgmObjectKey, setBgmObjectKey] = useState<string | null>(null);
  const [bgmVolume, setBgmVolume] = useState(0.3);

  const onErr = useCallback((msg: string) => show("err", msg), [show]);

  const refreshProjects = useCallback(async () => {
    try { setProjects(await listProjects(token)); } catch { /* 列表失败不阻断向导 */ }
  }, [token]);

  useEffect(() => {
    void (async () => {
      try { setPricing(await getDubPricing(token)); } catch (e) { onErr((e as Error).message); }
      await refreshProjects();
    })();
  }, [token, onErr, refreshProjects]);

  /** 懒建项目：真正产生结果时才落库，避免每次进页面都堆一条空草稿 */
  const ensureProject = useCallback(async (): Promise<string | null> => {
    if (projectId) return projectId;
    try {
      const p = await createProject(token);
      setProjectId(p.id);
      await refreshProjects();
      return p.id;
    } catch (e) {
      onErr((e as Error).message);
      return null;
    }
  }, [projectId, token, onErr, refreshProjects]);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      const id = await ensureProject();
      if (!id) return;
      try { await patchProject(token, id, patch); await refreshProjects(); } catch (e) { onErr((e as Error).message); }
    },
    [token, ensureProject, onErr, refreshProjects],
  );

  const resetToNew = () => {
    setProjectId(null);
    setAnalysis(null); setSpokenScript(""); setScript("");
    setAudioUrl(null); setAudioObjectKey(null); setAudioDurationSec(0);
    setAvatarId(null); setBgmPresetId(null); setBgmObjectKey(null); setBgmVolume(0.3);
    setStage("source");
  };

  /** 打开历史任务：把每一步状态都回填，用户可自由跳到任意一步复盘或续做 */
  const openProject = async (id: string) => {
    setBusy(true);
    try {
      const p = await getProject(token, id);
      setProjectId(p.id);
      setAnalysis(p.analysis);
      setSpokenScript(p.analysis?.spokenScript ?? "");
      setScript(p.script ?? "");
      setAudioUrl(p.audioUrl); setAudioObjectKey(p.audioObjectKey); setAudioDurationSec(p.audioDurationSec);
      setAvatarId(p.avatarId); setBgmPresetId(p.bgmPresetId); setBgmObjectKey(p.bgmObjectKey); setBgmVolume(p.bgmVolume);
      // 已出片/成片中的落到成片步；否则回到最后完成的那一步
      const landed: StageId = ["done", "failed", "generating", "mixing"].includes(p.stage)
        ? "result"
        : p.audioObjectKey ? "avatar" : (p.script || p.analysis) ? "rewrite" : "source";
      setStage(landed);
    } catch (e) {
      onErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (id: string) => {
    try {
      await deleteProject(token, id);
      if (id === projectId) resetToNew();
      await refreshProjects();
    } catch (e) { onErr((e as Error).message); }
  };

  const state = { spokenScript, script, audioObjectKey, avatarId };
  const canNext = canLeaveStage(stage, state);
  const finalText = effectiveScript(state);

  const goNext = () => {
    // 手写文案（无拆解结果）时跳过「拆解」步
    if (stage === "source" && !analysis) { setStage("rewrite"); return; }
    setStage(nextStage(stage));
  };

  const BUSY_COPY: Partial<Record<StageId, { title: string; hints: string[] }>> = {
    source: { title: "正在拆解参考视频…", hints: ["读取画面与人声", "逐字转写口播文稿", "归纳分镜、结构与卖点"] },
    rewrite: { title: "正在洗稿改写…", hints: ["理解原文核心信息", "检索你挂载的知识库", "换一种表达重新组织"] },
    voice: { title: "正在合成口播音频…", hints: ["生成音色", "逐句合成语音", "转存音频"] },
    avatar: { title: "正在克隆数字人形象…", hints: ["上传场景视频", "提取人物特征", "这步通常需要几分钟"] },
  };
  const busyCopy = busy ? BUSY_COPY[stage] : undefined;

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl gap-5 overflow-hidden p-6">
      <HistorySidebar
        projects={projects}
        activeId={projectId}
        onSelect={(id) => void openProject(id)}
        onCreate={resetToNew}
        onDelete={(id) => void removeProject(id)}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto">
        <header>
          <h1 className="flex items-center gap-2 text-[18px] font-semibold text-[#1d1d1f]">
            <Icon icon="mdi:account-voice" className="text-brand" /> 数字人口播
          </h1>
          <p className="mt-1 text-[12.5px] text-[#8a8a8f]">上传参考视频，自动拆解文案 → 洗稿 → 配音 → 数字人对口型成片。</p>
        </header>

        <StepRail active={stageIndex(stage)} busy={busy} onSelect={(i) => setStage(STAGES[i].id)} />

        <main className="relative flex-1">
          <BusyOverlay show={Boolean(busyCopy)} title={busyCopy?.title ?? ""} hints={busyCopy?.hints ?? []} />

          {stage === "source" && (
            <SourcePanel
              token={token} pricing={pricing} busy={busy} setBusy={setBusy} onErr={onErr}
              onAnalyzed={(a) => {
                setAnalysis(a); setSpokenScript(a.spokenScript);
                void save({ analysis: a, stage: "analyzed" });
                setStage("analysis");
              }}
              onManualScript={(t) => { setSpokenScript(t); void save({ script: t, stage: "scripted" }); setStage("rewrite"); }}
            />
          )}

          {stage === "analysis" && (analysis
            ? <AnalysisPanel analysis={analysis} spokenScript={spokenScript} onSpokenScriptChange={setSpokenScript} />
            : <Empty text="这个任务没有视频拆解结果（文案是手写的）。" />)}

          {stage === "rewrite" && (
            <RewritePanel
              token={token} spokenScript={spokenScript} script={script}
              highlights={analysis?.highlights ?? []}
              busy={busy} setBusy={setBusy} onErr={onErr}
              onScriptChange={(v) => { setScript(v); void save({ script: v, stage: "scripted" }); }}
              onKbIdsChange={(ids) => void save({ attachedKbIds: ids })}
            />
          )}

          {stage === "voice" && (
            <VoicePanel
              token={token} text={finalText} pricing={pricing} audioUrl={audioUrl}
              busy={busy} setBusy={setBusy} onErr={onErr}
              onVoiced={(r) => {
                setAudioUrl(r.audioUrl); setAudioObjectKey(r.objectKey); setAudioDurationSec(r.durationSec);
                void save({ audioUrl: r.audioUrl, audioObjectKey: r.objectKey, audioDurationSec: r.durationSec, ttsMode: r.mode, stage: "voiced" });
                void onBalanceRefresh?.();
              }}
            />
          )}

          {stage === "avatar" && (
            <AvatarPanel
              token={token} pricing={pricing} selectedAvatarId={avatarId}
              busy={busy} setBusy={setBusy} onErr={onErr}
              onSelect={(id) => { setAvatarId(id); void save({ avatarId: id }); }}
            />
          )}

          {stage === "bgm" && (
            <BgmPanel
              token={token} bgmPresetId={bgmPresetId} bgmObjectKey={bgmObjectKey} bgmVolume={bgmVolume}
              busy={busy} setBusy={setBusy} onErr={onErr}
              onChange={(v) => {
                setBgmPresetId(v.bgmPresetId); setBgmObjectKey(v.bgmObjectKey); setBgmVolume(v.bgmVolume);
                void save(v);
              }}
            />
          )}

          {stage === "result" && (projectId
            ? <ResultPanel key={projectId} token={token} projectId={projectId} pricing={pricing} audioDurationSec={audioDurationSec} onErr={onErr} onBalanceRefresh={onBalanceRefresh} />
            : <Empty text="请先完成配音与数字人形象，再来这一步成片。" />)}
        </main>

        <footer className="flex items-center justify-between border-t border-gray-100 pt-4">
          <button
            disabled={stage === "source" || busy}
            onClick={() => setStage(prevStage(stage))}
            className="rounded-lg border border-gray-200 px-4 py-2 text-[13px] text-[#5a5a60] disabled:opacity-40"
          >
            上一步
          </button>
          <span className="text-[12px] text-[#b6b6bd]">第 {stageIndex(stage) + 1} / {STAGES.length} 步 · 可点击上方步骤条自由切换</span>
          <button
            disabled={stage === "result" || !canNext || busy}
            onClick={goNext}
            className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
          >
            下一步
          </button>
        </footer>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-gray-200 p-10 text-center text-[13px] text-[#b6b6bd]">{text}</div>;
}
