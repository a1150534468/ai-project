import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "motion/react";
import { RippleButton, Stagger, StaggerItem, spring, msgIn } from "../../motion";
import {
  activateComicScriptVersion,
  createComicAsset,
  createComicBibleEntry,
  createComicEpisode,
  createComicProject,
  createComicScriptVersion,
  generateComicAssetImage,
  generateComicShotImage,
  generateComicShots,
  generateComicShotVideo,
  getComicProject,
  listComicAssets,
  listComicProjects,
  listComicShots,
  listComicVideoModels,
  pollComicShotVideo,
  renderComicEpisode,
  type ComicAsset,
  type ComicAssetType,
  type ComicEpisode,
  type ComicProjectDetail,
  type ComicProjectSummary,
  type ComicRenderManifest,
  type ComicShot,
  type ComicStage,
  type ComicVideoModel,
} from "../../workflowComicApi";

interface ComicWorkflowStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
}

const STAGES: readonly { readonly id: ComicStage; readonly label: string; readonly icon: string }[] = [
  { id: "script", label: "脚本", icon: "mdi:script-text-outline" },
  { id: "assets", label: "资产", icon: "mdi:account-box-multiple-outline" },
  { id: "storyboard", label: "分镜", icon: "mdi:view-grid-outline" },
  { id: "render", label: "渲染", icon: "mdi:movie-open-play-outline" },
];

const ASSET_TYPES: readonly { readonly id: ComicAssetType; readonly label: string }[] = [
  { id: "character", label: "角色" },
  { id: "scene", label: "场景" },
  { id: "prop", label: "道具" },
  { id: "style", label: "风格" },
];

function fallbackError(error: unknown, message: string): string {
  return error instanceof Error ? error.message : message;
}

function activeScript(episode: ComicEpisode | null) {
  return episode?.scriptVersions.find((version) => version.id === episode.scriptVersionId)
    ?? episode?.scriptVersions.find((version) => version.status === "active")
    ?? episode?.scriptVersions[0]
    ?? null;
}

function isComicAssetType(value: string): value is ComicAssetType {
  return ASSET_TYPES.some((item) => item.id === value);
}

function StatusPill({ children }: { readonly children: string }) {
  return <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand-ink">{children}</span>;
}

export function ComicWorkflowStudio({ token, onBalanceRefresh }: ComicWorkflowStudioProps) {
  const [projects, setProjects] = useState<readonly ComicProjectSummary[]>([]);
  const [project, setProject] = useState<ComicProjectDetail | null>(null);
  const [episodeId, setEpisodeId] = useState("");
  const [stage, setStage] = useState<ComicStage>("script");
  const [assets, setAssets] = useState<readonly ComicAsset[]>([]);
  const [shots, setShots] = useState<readonly ComicShot[]>([]);
  const [videoModels, setVideoModels] = useState<readonly ComicVideoModel[]>([]);
  const [selectedVideoModelId, setSelectedVideoModelId] = useState("seedance-lite");
  const [renderManifest, setRenderManifest] = useState<ComicRenderManifest | null>(null);
  const [projectForm, setProjectForm] = useState({ title: "", logline: "", style: "" });
  const [bibleForm, setBibleForm] = useState({ category: "character", title: "", content: "" });
  const [episodeForm, setEpisodeForm] = useState({ title: "", summary: "", targetDurationSec: 90 });
  const [scriptText, setScriptText] = useState("");
  const [assetForm, setAssetForm] = useState<{ readonly type: ComicAssetType; readonly name: string; readonly description: string; readonly prompt: string }>({
    type: "character",
    name: "",
    description: "",
    prompt: "",
  });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const selectedEpisode = useMemo(
    () => project?.episodes.find((episode) => episode.id === episodeId) ?? project?.episodes[0] ?? null,
    [episodeId, project],
  );
  const selectedScript = activeScript(selectedEpisode);
  const selectedProjectId = project?.id ?? "";

  const refreshProjects = useCallback(async () => {
    setProjects(await listComicProjects(token));
  }, [token]);

  const refreshProject = useCallback(async (projectId: string) => {
    const next = await getComicProject(token, projectId);
    setProject(next);
    setEpisodeId((current) => current || next.episodes[0]?.id || "");
  }, [token]);

  const refreshProduction = useCallback(async (projectId: string, nextEpisodeId: string) => {
    const [nextAssets, nextVideoModels] = await Promise.all([
      listComicAssets(token, projectId),
      listComicVideoModels(token),
    ]);
    setAssets(nextAssets);
    setVideoModels(nextVideoModels);
    setSelectedVideoModelId((current) => nextVideoModels.some((model) => model.id === current) ? current : nextVideoModels[0]?.id ?? "seedance-lite");
    setShots(nextEpisodeId ? await listComicShots(token, nextEpisodeId) : []);
  }, [token]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (project || projects.length === 0) return;
    void refreshProject(projects[0].id);
  }, [project, projects, refreshProject]);

  useEffect(() => {
    if (!selectedProjectId) return;
    void refreshProduction(selectedProjectId, selectedEpisode?.id ?? "");
  }, [refreshProduction, selectedEpisode?.id, selectedProjectId]);

  useEffect(() => {
    if (selectedScript) setScriptText(selectedScript.scriptText);
  }, [selectedScript?.id]);

  const run = (label: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setMessage("");
    void (async () => {
      try {
        await work();
        setMessage(label);
        onBalanceRefresh?.();
      } catch (error) {
        setMessage(fallbackError(error, `${label}失败`));
      } finally {
        setBusy("");
      }
    })();
  };

  const createProjectAction = () => run("已创建项目", async () => {
    const created = await createComicProject(token, projectForm);
    await refreshProjects();
    await refreshProject(created.id);
    setProjectForm({ title: "", logline: "", style: "" });
  });

  const createBibleAction = () => {
    if (!project) return;
    run("已保存设定", async () => {
      await createComicBibleEntry(token, project.id, { ...bibleForm, position: project.bibleEntries.length + 1 });
      await refreshProject(project.id);
      setBibleForm({ category: "character", title: "", content: "" });
    });
  };

  const createEpisodeAction = () => {
    if (!project) return;
    run("已创建剧集", async () => {
      const episode = await createComicEpisode(token, project.id, episodeForm);
      await refreshProject(project.id);
      setEpisodeId(episode.id);
      setEpisodeForm({ title: "", summary: "", targetDurationSec: 90 });
    });
  };

  const saveScriptAction = () => {
    if (!selectedEpisode || !project) return;
    run("已保存脚本", async () => {
      const version = await createComicScriptVersion(token, selectedEpisode.id, {
        outline: selectedEpisode.summary,
        scriptText,
        source: "manual",
        prompt: "",
      });
      await activateComicScriptVersion(token, version.id);
      await refreshProject(project.id);
      setStage("assets");
    });
  };

  const createAssetAction = () => {
    if (!project) return;
    run("已创建资产", async () => {
      await createComicAsset(token, project.id, assetForm);
      setAssets(await listComicAssets(token, project.id));
      setAssetForm({ type: "character", name: "", description: "", prompt: "" });
    });
  };

  const generateAssetImageAction = (asset: ComicAsset) => {
    if (!project) return;
    run("已生成资产图", async () => {
      await generateComicAssetImage(token, asset.id, asset.prompt || asset.description);
      setAssets(await listComicAssets(token, project.id));
    });
  };

  const generateShotsAction = () => {
    if (!selectedEpisode || !project) return;
    run("已生成分镜", async () => {
      setShots(await generateComicShots(token, selectedEpisode.id));
      await refreshProject(project.id);
      setStage("storyboard");
    });
  };

  const generateShotImageAction = (shot: ComicShot) => {
    if (!selectedEpisode) return;
    run("已生成镜头图", async () => {
      await generateComicShotImage(token, shot.id, shot.description);
      setShots(await listComicShots(token, selectedEpisode.id));
    });
  };

  const generateVideoAction = (shot: ComicShot) => {
    if (!selectedEpisode) return;
    run("已创建视频任务", async () => {
      await generateComicShotVideo(token, shot.id, selectedVideoModelId);
      setShots(await listComicShots(token, selectedEpisode.id));
      setStage("render");
    });
  };

  const pollVideoAction = (shot: ComicShot) => {
    if (!selectedEpisode) return;
    run("已刷新视频状态", async () => {
      await pollComicShotVideo(token, shot.id);
      setShots(await listComicShots(token, selectedEpisode.id));
    });
  };

  const renderAction = () => {
    if (!selectedEpisode) return;
    run("已生成渲染清单", async () => {
      setRenderManifest(await renderComicEpisode(token, selectedEpisode.id));
    });
  };

  return (
    <section className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="rounded-[14px] border border-[#e8e8ed] bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-[#1d1d1f]">漫剧项目</h2>
          <StatusPill>{`${projects.length} 个`}</StatusPill>
        </div>
        <div className="mt-4 space-y-2">
          {projects.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => void refreshProject(item.id)}
              className={`w-full rounded-[10px] border px-3 py-3 text-left transition ${project?.id === item.id ? "border-brand bg-brand-soft" : "border-[#e8e8ed] hover:border-brand/50"}`}
            >
              <p className="truncate text-sm font-semibold text-[#1d1d1f]">{item.title}</p>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#6e6e73]">{item.logline || item.style || "未填写简介"}</p>
            </button>
          ))}
        </div>
        <div className="mt-4 space-y-2 border-t border-[#e8e8ed] pt-4">
          <input value={projectForm.title} onChange={(event) => setProjectForm({ ...projectForm, title: event.target.value })} placeholder="项目名" className="h-10 w-full rounded-[10px] border border-[#d2d2d7] px-3 text-sm" />
          <input value={projectForm.logline} onChange={(event) => setProjectForm({ ...projectForm, logline: event.target.value })} placeholder="一句话剧情" className="h-10 w-full rounded-[10px] border border-[#d2d2d7] px-3 text-sm" />
          <input value={projectForm.style} onChange={(event) => setProjectForm({ ...projectForm, style: event.target.value })} placeholder="视觉风格" className="h-10 w-full rounded-[10px] border border-[#d2d2d7] px-3 text-sm" />
          <RippleButton type="button" onClick={createProjectAction} disabled={!projectForm.title.trim() || Boolean(busy)} className="h-10 w-full rounded-[10px] bg-brand text-sm font-semibold text-white disabled:opacity-50">
            <Icon icon="mdi:plus" className="mr-1 inline-block" aria-hidden />新建项目
          </RippleButton>
        </div>
      </aside>

      <div className="min-w-0 rounded-[14px] border border-[#e8e8ed] bg-white p-4 lg:p-5">
        {!project ? (
          <div className="grid min-h-[360px] place-items-center text-sm text-[#6e6e73]">选择或新建一个漫剧项目</div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-[#1d1d1f]">{project.title}</h2>
                <p className="mt-1 text-sm leading-6 text-[#6e6e73]">{project.logline || project.style || "补充设定后开始制作"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {STAGES.map((item) => (
                  <button key={item.id} type="button" onClick={() => setStage(item.id)} className={`h-9 rounded-[10px] px-3 text-sm font-semibold ${stage === item.id ? "bg-brand text-white" : "bg-[#f5f5f7] text-[#6e6e73] hover:text-brand-ink"}`}>
                    <Icon icon={item.icon} className="mr-1 inline-block" aria-hidden />{item.label}
                  </button>
                ))}
              </div>
            </div>

            {message && <div className="rounded-[10px] border border-brand/20 bg-brand-soft px-3 py-2 text-sm font-medium text-brand-ink">{message}</div>}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <main className="min-w-0 space-y-4">
                {stage === "script" && (
                  <div className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <input value={episodeForm.title} onChange={(event) => setEpisodeForm({ ...episodeForm, title: event.target.value })} placeholder="剧集标题" className="h-10 rounded-[10px] border border-[#d2d2d7] px-3 text-sm" />
                      <input value={episodeForm.summary} onChange={(event) => setEpisodeForm({ ...episodeForm, summary: event.target.value })} placeholder="剧集摘要" className="h-10 rounded-[10px] border border-[#d2d2d7] px-3 text-sm" />
                    </div>
                    <button type="button" onClick={createEpisodeAction} disabled={!episodeForm.title.trim() || Boolean(busy)} className="h-10 rounded-[10px] border border-brand px-4 text-sm font-semibold text-brand-ink disabled:opacity-50">创建剧集</button>
                    <div className="flex flex-wrap gap-2">
                      {project.episodes.map((episode) => (
                        <button key={episode.id} type="button" onClick={() => setEpisodeId(episode.id)} className={`rounded-[10px] border px-3 py-2 text-sm ${selectedEpisode?.id === episode.id ? "border-brand bg-brand-soft text-brand-ink" : "border-[#e8e8ed] text-[#6e6e73]"}`}>第 {episode.episodeNo} 集 · {episode.title}</button>
                      ))}
                    </div>
                    <textarea value={scriptText} onChange={(event) => setScriptText(event.target.value)} placeholder="粘贴或编写本集脚本" className="min-h-[280px] w-full rounded-[10px] border border-[#d2d2d7] p-3 text-sm leading-6 text-[#1d1d1f]" />
                    <RippleButton type="button" onClick={saveScriptAction} disabled={!selectedEpisode || !scriptText.trim() || Boolean(busy)} className="h-10 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50">保存并激活脚本</RippleButton>
                  </div>
                )}

                {stage === "assets" && (
                  <div className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-[140px_1fr_1fr]">
                      <select
                        value={assetForm.type}
                        onChange={(event) => {
                          if (isComicAssetType(event.target.value)) setAssetForm({ ...assetForm, type: event.target.value });
                        }}
                        className="h-10 rounded-[10px] border border-[#d2d2d7] px-3 text-sm"
                      >
                        {ASSET_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                      </select>
                      <input value={assetForm.name} onChange={(event) => setAssetForm({ ...assetForm, name: event.target.value })} placeholder="资产名称" className="h-10 rounded-[10px] border border-[#d2d2d7] px-3 text-sm" />
                      <input value={assetForm.description} onChange={(event) => setAssetForm({ ...assetForm, description: event.target.value })} placeholder="描述" className="h-10 rounded-[10px] border border-[#d2d2d7] px-3 text-sm" />
                    </div>
                    <RippleButton type="button" onClick={createAssetAction} disabled={!assetForm.name.trim() || Boolean(busy)} className="h-10 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50">添加资产</RippleButton>
                    {assets.length > 0 ? (
                      <Stagger className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {assets.map((asset) => (
                          <StaggerItem key={asset.id}>
                            <motion.article
                              layout
                              className="rounded-[10px] border border-[#e8e8ed] p-3"
                              whileHover={{ y: -4, boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)" }}
                              transition={spring.smooth}
                            >
                              <div className="aspect-[4/3] overflow-hidden rounded-[8px] bg-[#f5f5f7]">{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt={asset.name} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-xs text-[#8a8a8f]">未生成图片</div>}</div>
                              <div className="mt-3 flex items-start justify-between gap-2"><div><p className="font-semibold text-[#1d1d1f]">{asset.name}</p><p className="text-xs text-[#6e6e73]">{asset.type}</p></div><RippleButton type="button" onClick={() => generateAssetImageAction(asset)} className="h-8 rounded-[8px] bg-brand-soft px-3 text-xs font-semibold text-brand-ink">生图</RippleButton></div>
                            </motion.article>
                          </StaggerItem>
                        ))}
                      </Stagger>
                    ) : null}
                  </div>
                )}

                {stage === "storyboard" && (
                  <div className="space-y-3">
                    <RippleButton type="button" onClick={generateShotsAction} disabled={!selectedEpisode || Boolean(busy)} className="h-10 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50">从脚本生成分镜</RippleButton>
                    {shots.length > 0 ? (
                      <Stagger className="space-y-3">
                        {shots.map((shot) => (
                          <StaggerItem key={shot.id}>
                            <motion.article
                              layout
                              className="grid gap-3 rounded-[10px] border border-[#e8e8ed] p-3 md:grid-cols-[160px_minmax(0,1fr)_auto]"
                              whileHover={{ y: -4, boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)" }}
                              transition={spring.smooth}
                            >
                              <div className="aspect-video overflow-hidden rounded-[8px] bg-[#f5f5f7]">{shot.thumbnailUrl ? <img src={shot.thumbnailUrl} alt={shot.title || `镜头 ${shot.shotNo}`} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-xs text-[#8a8a8f]">镜头图</div>}</div>
                              <div className="min-w-0"><p className="font-semibold text-[#1d1d1f]">镜头 {shot.shotNo} {shot.title}</p><p className="mt-1 line-clamp-3 text-sm leading-6 text-[#6e6e73]">{shot.description}</p></div>
                              <div className="flex gap-2 md:flex-col"><RippleButton type="button" onClick={() => generateShotImageAction(shot)} className="h-9 rounded-[9px] bg-brand-soft px-3 text-xs font-semibold text-brand-ink">生图</RippleButton><RippleButton type="button" onClick={() => generateVideoAction(shot)} disabled={!shot.imageAssetId} className="h-9 rounded-[9px] border border-brand px-3 text-xs font-semibold text-brand-ink disabled:opacity-40">视频</RippleButton></div>
                            </motion.article>
                          </StaggerItem>
                        ))}
                      </Stagger>
                    ) : null}
                  </div>
                )}

                {stage === "render" && (
                  <div className="space-y-3">
                    <select value={selectedVideoModelId} onChange={(event) => setSelectedVideoModelId(event.target.value)} className="h-10 rounded-[10px] border border-[#d2d2d7] px-3 text-sm">
                      {videoModels.map((model) => <option key={model.id} value={model.id}>{model.label} · {model.resolution}</option>)}
                    </select>
                    {shots.length > 0 ? (
                      <Stagger className="space-y-3">
                        <AnimatePresence mode="popLayout">
                          {shots.map((shot) => (
                            <StaggerItem key={shot.id}>
                              <motion.div
                                layout
                                className="flex items-center justify-between gap-3 rounded-[10px] border border-[#e8e8ed] p-3"
                                whileHover={{ y: -4, boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)" }}
                                transition={spring.smooth}
                              >
                                <div className="min-w-0"><p className="text-sm font-semibold text-[#1d1d1f]">镜头 {shot.shotNo}</p><p className="text-xs text-[#6e6e73]">{shot.videoStatus}{shot.videoUrl ? " · 已有视频" : ""}</p></div>
                                <RippleButton type="button" onClick={() => pollVideoAction(shot)} disabled={!shot.videoTaskId} className="h-9 rounded-[9px] bg-brand-soft px-3 text-xs font-semibold text-brand-ink disabled:opacity-40">刷新</RippleButton>
                              </motion.div>
                            </StaggerItem>
                          ))}
                        </AnimatePresence>
                      </Stagger>
                    ) : null}
                    <RippleButton type="button" onClick={renderAction} disabled={!selectedEpisode || Boolean(busy)} className="h-10 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50">生成整集清单</RippleButton>
                    {renderManifest && <pre className="max-h-56 overflow-auto rounded-[10px] bg-[#f7faf9] p-3 text-xs text-[#1d1d1f]">{JSON.stringify(renderManifest, null, 2)}</pre>}
                  </div>
                )}
              </main>

              <aside className="space-y-3 rounded-[10px] bg-[#f7faf9] p-3">
                <h3 className="text-sm font-semibold text-[#1d1d1f]">设定资料</h3>
                <div className="space-y-2">
                  {project.bibleEntries.map((entry) => <div key={entry.id} className="rounded-[8px] border border-[#e8e8ed] bg-white p-2"><p className="text-xs font-semibold text-brand-ink">{entry.category}</p><p className="text-sm font-semibold text-[#1d1d1f]">{entry.title}</p></div>)}
                </div>
                <input value={bibleForm.title} onChange={(event) => setBibleForm({ ...bibleForm, title: event.target.value })} placeholder="设定标题" className="h-10 w-full rounded-[10px] border border-[#d2d2d7] px-3 text-sm" />
                <textarea value={bibleForm.content} onChange={(event) => setBibleForm({ ...bibleForm, content: event.target.value })} placeholder="设定内容" className="min-h-24 w-full rounded-[10px] border border-[#d2d2d7] p-3 text-sm" />
                <button type="button" onClick={createBibleAction} disabled={!bibleForm.title.trim() || Boolean(busy)} className="h-10 w-full rounded-[10px] border border-brand text-sm font-semibold text-brand-ink disabled:opacity-50">添加设定</button>
              </aside>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
