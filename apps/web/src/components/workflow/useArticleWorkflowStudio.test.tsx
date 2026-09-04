// @vitest-environment jsdom

/**
 * 图文工坊控制器的直测。既有的 `ArticleWorkflowStudio.test.tsx` /
 * `.retry.test.tsx` 是从 DOM 那一侧进来的，覆盖不到几处「只有控制器自己知道」的接缝：
 * 按平台隔离的草稿与脏标记、轮询回填时 force=false 的保草稿路径、离开脏页的确认闸门、
 * 保存的 409 竞态。这个文件专门盯这些，拆分前先立住。
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../motion/Toast";
import { ApiError } from "../../apiError";
import type { ArticleWorkflowStudioProps } from "./articleWorkflowStudioModel";
import { useArticleWorkflowStudio } from "./useArticleWorkflowStudio";

const api = vi.hoisted(() => ({
  applyArticleWorkflowTheme: vi.fn(),
  createArticleWorkflowProject: vi.fn(),
  deleteArticleWorkflowProject: vi.fn(),
  generateArticleWorkflowImages: vi.fn(),
  getArticleWorkflowBatch: vi.fn(),
  getArticleWorkflowProject: vi.fn(),
  listArticleWorkflowHistory: vi.fn(),
  regenerateArticleWorkflowImage: vi.fn(),
  retryArticleWorkflowProject: vi.fn(),
  rewriteArticleWorkflowProject: vi.fn(),
  updateArticleWorkflowProject: vi.fn(),
}));

vi.mock("../../workflowArticleApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../workflowArticleApi")>(),
  ...api,
}));

type Controller = ReturnType<typeof useArticleWorkflowStudio>;

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    creationMode: "source" as const,
    creationConfig: { mode: "source" as const, generateImages: true },
    sourceFormat: "plain-text" as const,
    sourceText: "开头第一段。",
    generationMode: "preserve-text" as const,
    platform: "wechat" as const,
    batchId: "batch-1",
    theme: "auto" as const,
    themeColor: null,
    galleryMode: "collage" as const,
    title: "咖啡机夏促",
    summary: "公众号摘要",
    bodyHtml: "<p>开头第一段。</p>",
    bodyMarkdown: "",
    imageManifestJson: [],
    captionText: "",
    tags: [] as readonly string[],
    status: "ready" as const,
    progressStage: "ready",
    progressPercent: 100,
    progressMessage: "已生成完成",
    error: null,
    createdAt: "2026-08-20T06:00:00.000Z",
    updatedAt: "2026-08-20T06:00:00.000Z",
    ...overrides,
  };
}

const xiaohongshu = (overrides: Record<string, unknown> = {}) => project({
  id: "article-2",
  platform: "xiaohongshu" as const,
  generationMode: "polish-text" as const,
  title: "小红书标题",
  summary: "",
  bodyHtml: "",
  captionText: "第一次用就回不去了。",
  ...overrides,
});

let latest: Controller | null = null;

function Probe(props: ArticleWorkflowStudioProps) {
  latest = useArticleWorkflowStudio(props);
  return null;
}

/** 控制器句柄每次渲染都会换新，所以一律通过 `studio()` 取当次渲染的那份 */
async function mountStudio(props: Partial<ArticleWorkflowStudioProps> = {}) {
  render(
    <ToastProvider>
      <Probe token="token" initialHistory={[]} initialBootstrapping={false} {...props} />
    </ToastProvider>,
  );
  await act(async () => { await Promise.resolve(); });
  return () => latest as Controller;
}

/** 载入一个双平台批次（wechat + xiaohongshu），返回控制器取值器 */
async function mountBatch(rows: readonly ReturnType<typeof project>[]) {
  api.getArticleWorkflowBatch.mockResolvedValue({ batchId: "batch-1", projects: rows });
  const studio = await mountStudio();
  await act(async () => {
    studio().handleSelectBatch({ key: "batch:batch-1", batchId: "batch-1", projectId: rows[0]!.id });
  });
  return studio;
}

beforeEach(() => {
  api.listArticleWorkflowHistory.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  latest = null;
});

describe("草稿与脏标记按平台隔离", () => {
  it("切平台不会把脏标记和草稿带过去", async () => {
    const studio = await mountBatch([project(), xiaohongshu()]);

    expect(studio().activePlatform).toBe("wechat");
    expect(studio().titleDraft).toBe("咖啡机夏促");

    await act(async () => { studio().markTitleDirty("公众号改过的标题"); });
    expect(studio().dirty).toBe(true);
    expect(studio().dirtyPlatforms).toEqual(["wechat"]);

    await act(async () => { studio().handleSelectPlatform("xiaohongshu"); });
    // 小红书这一行用户没动过：草稿是服务端值，脏标记不跟着过来
    expect(studio().titleDraft).toBe("小红书标题");
    expect(studio().dirty).toBe(false);
    expect(studio().dirtyPlatforms).toEqual(["wechat"]);

    await act(async () => { studio().handleSelectPlatform("wechat"); });
    expect(studio().titleDraft).toBe("公众号改过的标题");
    expect(studio().dirty).toBe(true);
  });

  it("内容改回原样会自动撤销脏标记", async () => {
    const studio = await mountBatch([project()]);

    await act(async () => { studio().markTitleDirty("改了"); });
    expect(studio().dirty).toBe(true);

    await act(async () => { studio().markTitleDirty("咖啡机夏促"); });
    // 编辑器载入时的规范化回写就靠这条不发车
    expect(studio().dirty).toBe(false);
    expect(studio().canSave).toBe(false);
  });

  it("failed 行连脏标记都不打，保存入口也不开", async () => {
    const studio = await mountBatch([project({ status: "failed", error: "403 model denied" })]);

    await act(async () => { studio().markTitleDirty("手改一段"); });
    expect(studio().dirty).toBe(false);
    expect(studio().canSave).toBe(false);
    // 草稿本身照旧跟随输入，只是不进入待保存
    expect(studio().titleDraft).toBe("手改一段");
  });
});

describe("批次轮询", () => {
  it("回填时保住正在编辑的平台草稿，全部落地后报完成", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getArticleWorkflowBatch.mockResolvedValue({
      batchId: "batch-1",
      projects: [project(), xiaohongshu({ status: "generating", progressMessage: "生成中" })],
    });
    const studio = await mountStudio();
    await act(async () => {
      studio().handleSelectBatch({ key: "batch:batch-1", batchId: "batch-1", projectId: "article-1" });
    });
    expect(studio().batchBusy).toBe(true);

    await act(async () => { studio().markTitleDirty("公众号改过的标题"); });
    // ready 行打脏 1.5s 后自动保存必然发车。这里让它挂着不回，脏标记就留在原地，
    // 正好用来验轮询回填的 force=false 分支不会把这份草稿冲掉。
    api.updateArticleWorkflowProject.mockReturnValue(new Promise(() => undefined));

    api.getArticleWorkflowBatch.mockResolvedValue({
      batchId: "batch-1",
      projects: [project({ title: "服务端后来又改了标题" }), xiaohongshu()],
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    // force=false：用户手里那份不能被服务端值冲掉，脏标记也要留着
    expect(studio().titleDraft).toBe("公众号改过的标题");
    expect(studio().dirtyPlatforms).toEqual(["wechat"]);
    expect(studio().batchBusy).toBe(false);
    expect(studio().notice).toBe("2 个平台已生成");
  });

  it("轮询到失败行把失败原因写进 error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getArticleWorkflowBatch.mockResolvedValue({
      batchId: "batch-1",
      projects: [project({ status: "generating" })],
    });
    const studio = await mountStudio();
    await act(async () => {
      studio().handleSelectBatch({ key: "batch:batch-1", batchId: "batch-1", projectId: "article-1" });
    });

    api.getArticleWorkflowBatch.mockResolvedValue({
      batchId: "batch-1",
      projects: [project({ status: "failed", error: "403 model denied" })],
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(studio().error).toContain("403 model denied");
    expect(studio().notice).toBe("图文处理失败");
  });

  it("配图失败（行仍是 ready）也要报出来，不能只看 failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getArticleWorkflowBatch.mockResolvedValue({
      batchId: "batch-1",
      projects: [project({ status: "generating" })],
    });
    const studio = await mountStudio();
    await act(async () => {
      studio().handleSelectBatch({ key: "batch:batch-1", batchId: "batch-1", projectId: "article-1" });
    });

    api.getArticleWorkflowBatch.mockResolvedValue({
      batchId: "batch-1",
      projects: [project({ status: "ready", error: "配图上游 429" })],
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(studio().error).toContain("配图上游 429");
    expect(studio().notice).toBe("1 个平台已生成");
  });
});

describe("离开未保存的项目要先确认", () => {
  it("确认框被取消就不切项目", async () => {
    const studio = await mountBatch([project()]);
    await act(async () => { studio().markTitleDirty("改了没存"); });
    api.getArticleWorkflowBatch.mockClear();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await act(async () => {
      studio().handleSelectBatch({ key: "batch:batch-2", batchId: "batch-2", projectId: "article-9" });
    });

    expect(confirm).toHaveBeenCalled();
    expect(api.getArticleWorkflowBatch).not.toHaveBeenCalled();
    expect(studio().titleDraft).toBe("改了没存");
  });

  it("确认后回到新建态会清掉所有平台草稿", async () => {
    const studio = await mountBatch([project(), xiaohongshu()]);
    await act(async () => { studio().markTitleDirty("改了没存"); });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await act(async () => { studio().handleNewProject(); });

    expect(studio().project).toBeNull();
    expect(studio().activePlatform).toBeNull();
    expect(studio().titleDraft).toBe("");
    expect(studio().dirtyPlatforms).toEqual([]);
    expect(studio().selectedPlatforms).toEqual(["wechat", "xiaohongshu", "douyin"]);
  });
});

describe("保存", () => {
  it("手动保存按 caption / html 分字段提交，成功后落基线并撤脏", async () => {
    const studio = await mountBatch([project()]);
    api.updateArticleWorkflowProject.mockResolvedValue(project({ title: "公众号改过的标题" }));
    await act(async () => { studio().markTitleDirty("  公众号改过的标题  "); });

    await act(async () => { await studio().handleSave(); });

    expect(api.updateArticleWorkflowProject).toHaveBeenCalledWith("token", "article-1", {
      title: "公众号改过的标题",
      summary: "公众号摘要",
      bodyHtml: "<p>开头第一段。</p>",
    });
    expect(studio().dirty).toBe(false);
    expect(studio().notice).toBe("已保存修改");

    // 基线已更新：内容没再变，第二次保存不该再打接口
    api.updateArticleWorkflowProject.mockClear();
    await act(async () => { await studio().handleSave(); });
    expect(api.updateArticleWorkflowProject).not.toHaveBeenCalled();
  });

  it("caption 平台提交 captionText 与 tags，不带 bodyHtml", async () => {
    const studio = await mountBatch([xiaohongshu()]);
    api.updateArticleWorkflowProject.mockResolvedValue(xiaohongshu({ captionText: "改后的文案" }));
    await act(async () => { studio().markCaptionDirty("改后的文案"); });
    await act(async () => { studio().markTagsDirty([" 咖啡机 ", ""]); });

    await act(async () => { await studio().handleSave(); });

    expect(api.updateArticleWorkflowProject).toHaveBeenCalledWith("token", "article-2", {
      title: "小红书标题",
      summary: "",
      captionText: "改后的文案",
      tags: ["咖啡机"],
    });
  });

  it("保存撞上 409（这行已变 failed / 生成中）静默撤脏并刷该行，不弹错", async () => {
    const studio = await mountBatch([project()]);
    api.updateArticleWorkflowProject.mockRejectedValue(new ApiError("conflict", 409));
    api.getArticleWorkflowProject.mockResolvedValue(project({ status: "failed", error: "上游 403" }));
    await act(async () => { studio().markTitleDirty("改了"); });

    await act(async () => { await studio().handleSave(); });

    expect(studio().error).toBe("");
    expect(studio().dirty).toBe(false);
    expect(studio().project?.status).toBe("failed");
  });
});

describe("创作表单", () => {
  it("切成主题创作会重置草稿并把配图/文本模式一起换过去", async () => {
    const studio = await mountStudio();
    expect(studio().creationDraft.mode).toBe("source");
    expect(studio().generateImages).toBe(true);

    await act(async () => { studio().handleCreationModeChange("topic"); });

    expect(studio().creationDraft).toEqual({
      mode: "topic", topic: "", keyPoints: "", audience: "", avoid: "",
      style: { mode: "preset", preset: "general" },
    });
    // 主题创作默认先出文案，不连带生图
    expect(studio().generateImages).toBe(false);
    expect(studio().generationMode).toBe("polish-text");
    expect(studio().canGenerate).toBe(false);
  });

  it("勾选平台保持固定顺序，且不允许全部取消", async () => {
    const studio = await mountStudio();

    await act(async () => { studio().handleTogglePlatform("wechat"); });
    await act(async () => { studio().handleTogglePlatform("xiaohongshu"); });
    expect(studio().selectedPlatforms).toEqual(["douyin"]);

    // 只剩一个时再点它无效
    await act(async () => { studio().handleTogglePlatform("douyin"); });
    expect(studio().selectedPlatforms).toEqual(["douyin"]);

    await act(async () => { studio().handleTogglePlatform("wechat"); });
    expect(studio().selectedPlatforms).toEqual(["wechat", "douyin"]);
  });

  it("提交生成用当前草稿与勾选平台建批次，然后回填", async () => {
    const studio = await mountStudio();
    api.createArticleWorkflowProject.mockResolvedValue({
      batchId: "batch-1", projectId: "article-1", projects: [{ platform: "wechat" }],
    });
    api.getArticleWorkflowBatch.mockResolvedValue({ batchId: "batch-1", projects: [project()] });

    await act(async () => { studio().setCreationDraft({ mode: "source", sourceFormat: "markdown", sourceText: " # 标题 " }); });
    expect(studio().canGenerate).toBe(true);
    await act(async () => { studio().handleGenerate(); });

    expect(api.createArticleWorkflowProject).toHaveBeenCalledWith("token", expect.objectContaining({
      creationMode: "source",
      sourceFormat: "markdown",
      sourceText: "# 标题",
      generationMode: "preserve-text",
      platforms: ["wechat", "xiaohongshu", "douyin"],
      generateImages: true,
    }));
    expect(studio().notice).toBe("已开始生成 1 个平台的图文");
    expect(studio().project?.id).toBe("article-1");
  });
});

describe("预览态换肤", () => {
  it("试看只改预览态，重置后回到跟随项目", async () => {
    const studio = await mountBatch([project()]);

    await act(async () => { studio().onPreviewThemeChange("literary"); });
    await act(async () => { studio().onPreviewThemeColorChange("#123456"); });
    await act(async () => { studio().onPreviewGalleryModeChange("grid"); });
    expect(studio().previewTheme).toBe("literary");
    expect(studio().previewThemeColor).toBe("#123456");
    expect(studio().previewGalleryMode).toBe("grid");
    // 项目本身没动，换肤要点「应用」才落库
    expect(studio().project?.theme).toBe("auto");

    await act(async () => { studio().onResetPreviewTheme(); });
    expect(studio().previewTheme).toBeNull();
    expect(studio().previewThemeColor).toBeNull();
    expect(studio().previewGalleryMode).toBeNull();
  });

  it("应用主题把预览态提交给后端并清空预览态", async () => {
    const studio = await mountBatch([project()]);
    api.applyArticleWorkflowTheme.mockResolvedValue(project({ theme: "literary", bodyHtml: "<p>换肤后</p>" }));

    await act(async () => { studio().onPreviewThemeChange("literary"); });
    await act(async () => { studio().handleApplyTheme(); });

    expect(api.applyArticleWorkflowTheme).toHaveBeenCalledWith("token", "article-1", {
      theme: "literary", themeColor: null, galleryMode: "collage",
    });
    expect(studio().previewTheme).toBeNull();
    expect(studio().bodyHtmlDraft).toBe("<p>换肤后</p>");
    expect(studio().dirty).toBe(false);
  });
});
