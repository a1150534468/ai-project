import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeNovelChapter,
  generateNovelChapter,
  generateNovelSetup,
  getNovelProject,
  getNovelWorkbench,
  rewriteNovelChapterSelection,
  saveNovelChapter,
  saveNovelChapterReview,
} from "./api";

/**
 * 小说接口本身住在 `novelApi.ts`，这里刻意从 `./api` 门面 import —— 68 个调用方走的是
 * 这条路，`export *` 哪天漏了一个名字，得由这个文件先红。
 */

const AT = "2026-07-01T08:00:00.000Z";

/** 断言只看「请求发成什么样」，所以响应体只要形状合法即可，内容随便给。 */
function stubFetch(payload: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: payload }), { status }),
  );
}

function task(targetKind: string, targetId: string | null = null) {
  return {
    id: "task-1",
    projectId: "project-1",
    targetKind,
    targetId,
    status: "queued",
    requestPayload: {},
    error: null,
    createdAt: AT,
    updatedAt: AT,
    completedAt: null,
    cancelledAt: null,
  };
}

function chapter(extra: Record<string, unknown> = {}) {
  return { id: "chapter-1", volumeIndex: 1, chapterIndex: 1, title: "寒泉院", updatedAt: AT, ...extra };
}

const project = { id: "project-1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: AT, updatedAt: AT };

/**
 * 一个用例 = 打一个接口，然后核对「打到哪个 URL、用什么方法、body 里发了什么」。
 * 八个接口的验证方式一模一样，所以排成表；表外只留一个读返回值的用例。
 */
interface Probe {
  readonly what: string;
  readonly reply: unknown;
  readonly status?: number;
  readonly call: () => Promise<unknown>;
  readonly url: string;
  readonly init: Record<string, unknown>;
}

const CHAPTER_EDIT = { title: "寒泉院", summary: "危机升级", content: "新正文" };
const REWRITE = { selectedText: "她推开门", selectionStart: 4, selectionEnd: 8, instruction: "增强动作张力" };
const CHAPTER_PLAN = { chapterIndex: 3, title: "寒泉院", summary: "危机升级", targetChars: 3000 };
const REVIEW = { status: "approved" as const, reviewNotes: "已改。" };

const PROBES: readonly Probe[] = [
  {
    what: "设定生成：prompt 原样发给小说 worker",
    reply: { task: task("setupCharacters") },
    status: 202,
    call: () => generateNovelSetup("token", "project-1", "characters", "补充反派"),
    url: "/api/workflow/novels/projects/project-1/setup/characters/generate",
    init: { method: "POST", body: JSON.stringify({ prompt: "补充反派" }) },
  },
  {
    what: "章节生成：带上选中的章序号与目标字数",
    reply: { task: task("chapter") },
    status: 202,
    call: () => generateNovelChapter("token", "project-1", CHAPTER_PLAN),
    url: "/api/workflow/novels/projects/project-1/chapters/generate",
    init: { method: "POST", body: JSON.stringify(CHAPTER_PLAN) },
  },
  {
    what: "保存正文走 PUT，章序号在路径上",
    reply: { chapter: chapter({ content: "新正文", status: "ready", billableChars: 3 }) },
    call: () => saveNovelChapter("token", "project-1", 1, CHAPTER_EDIT),
    url: "/api/workflow/novels/projects/project-1/chapters/1",
    init: { method: "PUT", body: JSON.stringify(CHAPTER_EDIT) },
  },
  {
    what: "局部重写：选区的起止下标要精确送到后端",
    reply: { task: task("chapterRewrite", "chapter-1") },
    status: 202,
    call: () => rewriteNovelChapterSelection("token", "project-1", 3, REWRITE),
    url: "/api/workflow/novels/projects/project-1/chapters/3/rewrite",
    init: { method: "POST", body: JSON.stringify(REWRITE) },
  },
  {
    what: "工作台是只读接口，用 GET",
    reply: {
      project,
      stats: { totalWords: 10, finishedChapters: 1, completionRate: 8, averageWords: 10, lastUpdate: AT },
      chapters: [],
      knowledgeFacts: [],
      foreshadowItems: [],
      workbenchHighlights: {
        focusChapterNumber: 2,
        recommendedFocus: "",
        dueForeshadowItems: [],
        continuityAlerts: [],
        microBeats: [],
        focusCard: null,
        qualitySnapshot: { consistencyStatus: "ok", consistencyRisks: [], styleRisk: "low", styleTone: "" },
        workflowGate: null,
      },
    },
    call: () => getNovelWorkbench("token", "project-1"),
    url: "/api/workflow/novels/projects/project-1/workbench",
    init: { method: "GET" },
  },
  {
    what: "审阅结论：状态与备注一起提交",
    reply: { chapter: chapter({ reviewStatus: "approved", reviewNotes: "已改。" }) },
    call: () => saveNovelChapterReview("token", "project-1", 1, REVIEW),
    url: "/api/workflow/novels/projects/project-1/chapters/1/review",
    init: { method: "POST", body: JSON.stringify(REVIEW) },
  },
  {
    what: "重跑章节分析不带 body",
    reply: { chapter: chapter() },
    call: () => analyzeNovelChapter("token", "project-1", 1),
    url: "/api/workflow/novels/projects/project-1/chapters/1/analyze",
    init: { method: "POST" },
  },
];

describe("小说工作流接口（经 api.ts 门面）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const probe of PROBES) {
    it(probe.what, async () => {
      const fetchMock = stubFetch(probe.reply, probe.status);

      await probe.call();

      expect(fetchMock).toHaveBeenCalledWith(probe.url, expect.objectContaining(probe.init));
    });
  }

  it("项目详情把锁定的故事圣经解出来", async () => {
    stubFetch({
      project,
      bible: {
        id: "bible-1",
        premiseLock: "长夜将尽",
        genreLock: "玄幻",
        worldPresetLock: "",
        version: 1,
        worldDimensions: [],
        styleNotes: [],
        updatedAt: AT,
      },
      chapters: [],
      tasks: [],
    });

    const detail = await getNovelProject("token", "project-1");

    expect(detail.bible?.premiseLock).toContain("长夜将尽");
  });
});
