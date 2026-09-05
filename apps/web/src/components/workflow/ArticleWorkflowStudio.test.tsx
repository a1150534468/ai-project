// @vitest-environment jsdom

/**
 * 图文工作台「界面接对了没有」这一层。
 *
 * 上一版是四条 `renderToStaticMarkup` + `toContain`：把整棵树渲成一个字符串，再拿文案去里面搜。
 * 那种断言只能证明某几个字符出现过 —— 页签点下去会不会换平台、取消勾选公众号之后那两组只对
 * 公众号有意义的配置会不会跟着收掉，它一概不知道。所以这里换成 RTL：按可访问名取节点、点、
 * 断言状态。
 *
 * 顺手把 `ArticleWorkflowPlatformTabs` 的用例补齐 —— 它自己没有测试文件，之前只被断言过
 * 「字符串里有三个 role="tab"」，连点击回不回报平台名都没测过。
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleWorkflowPlatform } from "@ai-assistant/article-workflow";
import { ToastProvider } from "../../motion/Toast";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";
import { ArticleWorkflowPlatformTabs } from "./ArticleWorkflowPlatformTabs";
import { ArticleWorkflowStudio } from "./ArticleWorkflowStudio";

const api = vi.hoisted(() => ({ listArticleWorkflowHistory: vi.fn() }));

vi.mock("../../workflowArticleApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../workflowArticleApi")>(),
  ...api,
}));

/** 公众号完成态：一张已出图的头图 + 一段 HTML 正文，够 `ArticleWorkflowEditor` 走完 html 分支。 */
function project(overrides: Record<string, unknown> = {}): ArticleWorkflowProject {
  return {
    id: "article-wechat",
    creationMode: "source",
    creationConfig: { mode: "source", generateImages: true },
    sourceFormat: "markdown",
    sourceText: "# 标题\n\n正文",
    generationMode: "preserve-text",
    platform: "wechat",
    batchId: "batch-1",
    theme: "auto",
    themeColor: null,
    galleryMode: "collage",
    title: "咖啡机夏促",
    summary: "适合公众号摘要",
    bodyHtml: '<section><p>开头第一段。</p></section>',
    bodyMarkdown: "",
    imageManifestJson: [{
      slot: "cover",
      role: "cover",
      assetId: "asset-1",
      imageUrl: "https://example.test/cover.png",
      thumbnailUrl: "https://example.test/cover-thumb.png",
      alt: "头图",
      caption: "",
      prompt: "cover prompt",
    }],
    captionText: "",
    tags: [],
    status: "ready",
    progressStage: "ready",
    progressPercent: 100,
    progressMessage: "已生成完成",
    error: null,
    createdAt: "2026-07-08T06:00:00.000Z",
    updatedAt: "2026-07-08T06:00:00.000Z",
    ...overrides,
  } as unknown as ArticleWorkflowProject;
}

/** 小红书完成态：走 caption 编辑器（纯 textarea），不必把富文本编辑器拖进 jsdom。 */
const XIAOHONGSHU = {
  id: "article-xhs",
  platform: "xiaohongshu",
  generationMode: "polish-text",
  title: "夏天必囤的咖啡机",
  summary: "",
  bodyHtml: "",
  imageManifestJson: [],
  captionText: "第一次用就回不去了。\n\n出杯快，清洗也简单。",
  tags: ["咖啡机", "居家好物", "夏日饮品"],
};

function renderTabs(args: {
  readonly projects: readonly ArticleWorkflowProject[];
  readonly activePlatform?: ArticleWorkflowPlatform;
  readonly dirtyPlatforms?: readonly ArticleWorkflowPlatform[];
  readonly onSelectPlatform?: (platform: ArticleWorkflowPlatform) => void;
}) {
  return render(
    <ArticleWorkflowPlatformTabs
      projects={args.projects}
      activePlatform={args.activePlatform ?? "wechat"}
      dirtyPlatforms={args.dirtyPlatforms ?? []}
      onSelectPlatform={args.onSelectPlatform ?? (() => undefined)}
    />,
  );
}

async function renderStudio(initialProject: ArticleWorkflowProject | null) {
  const view = render(
    <ToastProvider>
      <ArticleWorkflowStudio token="token" initialHistory={[]} initialProject={initialProject} initialBootstrapping={false} />
    </ToastProvider>,
  );
  // 挂载后还有一次拉历史要落地，先冲一遍微任务再断言，免得 act 告警
  await act(async () => { await Promise.resolve(); });
  return view;
}

/** 配置面板与输出区里有同名文案，断言一律先框到左边这块。 */
function configPanel(): HTMLElement {
  return screen.getByRole("region", { name: "图文生成配置" });
}

beforeEach(() => {
  api.listArticleWorkflowHistory.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("平台页签", () => {
  const THREE: readonly ArticleWorkflowProject[] = [
    project(),
    project(XIAOHONGSHU),
    project({ ...XIAOHONGSHU, id: "article-dy", platform: "douyin" }),
  ];

  it("单平台批次一个页签都不画：一行没得切的 UI 不如不要", () => {
    const { container } = renderTabs({ projects: [project()] });

    expect(container).toBeEmptyDOMElement();
  });

  it("三个平台一人一个页签，选中的那个标 aria-selected，点别人报回平台名", () => {
    const onSelectPlatform = vi.fn();
    renderTabs({ projects: THREE, activePlatform: "xiaohongshu", onSelectPlatform });

    const list = screen.getByRole("tablist");
    // 短标签：别让「微信公众号」把一行挤满
    expect(within(list).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["公众号", "小红书", "抖音"]);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("小红书");

    fireEvent.click(screen.getByRole("tab", { name: /抖音/ }));

    expect(onSelectPlatform).toHaveBeenCalledWith("douyin");
  });

  it("生成中盖过待保存：还在写的那行只挂转圈，脏标记等它停下来才出现", () => {
    renderTabs({
      projects: [
        project({ status: "generating" }),
        project({ ...XIAOHONGSHU, status: "failed" }),
        project({ ...XIAOHONGSHU, id: "article-dy", platform: "douyin" }),
      ],
      dirtyPlatforms: ["wechat", "xiaohongshu", "douyin"],
    });
    const [wechat, xiaohongshu, douyin] = screen.getAllByRole("tab");

    expect(within(wechat!).getByLabelText("生成中")).toBeInTheDocument();
    expect(within(wechat!).queryByLabelText("待保存")).toBeNull();

    expect(within(xiaohongshu!).getByLabelText("生成失败")).toBeInTheDocument();
    expect(within(xiaohongshu!).getByLabelText("待保存")).toBeInTheDocument();

    expect(within(douyin!).queryByLabelText("生成失败")).toBeNull();
    expect(within(douyin!).getByLabelText("待保存")).toBeInTheDocument();
  });
});

describe("新建态的生成配置", () => {
  it("三个平台默认全勾，提交按钮上写着平台数", async () => {
    await renderStudio(null);
    const config = configPanel();

    const platforms = within(config).getAllByRole("checkbox");
    expect(platforms.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    expect(within(config).getByRole("button", { name: "生成 3 个平台图文" })).toBeInTheDocument();
    // 还没写原文，按钮是灰的
    expect(within(config).getByRole("button", { name: "生成 3 个平台图文" })).toBeDisabled();
  });

  it("取消勾选公众号：按钮上的数量跟着减，只对公众号有意义的两组配置一起收掉", async () => {
    await renderStudio(null);
    const config = configPanel();
    expect(within(config).getByText("公众号生成方式")).toBeInTheDocument();
    expect(within(config).getByText("排版主题")).toBeInTheDocument();

    fireEvent.click(within(config).getByRole("checkbox", { name: /微信公众号/ }));

    expect(within(config).getByRole("checkbox", { name: /微信公众号/ })).toHaveAttribute("aria-checked", "false");
    expect(within(config).getByRole("button", { name: "生成 2 个平台图文" })).toBeInTheDocument();
    expect(within(config).queryByText("公众号生成方式")).toBeNull();
    expect(within(config).queryByText("排版主题")).toBeNull();
  });

  it("关掉「同时生成配图」，提交按钮从图文改口叫文案", async () => {
    await renderStudio(null);
    const config = configPanel();

    // 名字用正则：ui/Switch 的无障碍名把 label 和那行小字一起算进去，而小字本身跟着开关状态换词
    fireEvent.click(within(config).getByRole("switch", { name: /同时生成配图/ }));

    expect(within(config).getByRole("button", { name: "生成 3 个平台文案" })).toBeInTheDocument();
  });

  it("原文格式在纯文本与 Markdown 之间切，输入框的占位文案跟着换", async () => {
    await renderStudio(null);
    const config = configPanel();
    expect(within(config).getByLabelText("文章原文")).toHaveAttribute("placeholder", "粘贴文章正文");
    expect(within(config).getByRole("button", { name: "纯文本" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(config).getByRole("button", { name: "Markdown" }));

    expect(within(config).getByLabelText("文章原文")).toHaveAttribute("placeholder", "粘贴 Markdown 内容");
    expect(within(config).getByRole("button", { name: "Markdown" })).toHaveAttribute("aria-pressed", "true");
    expect(within(config).getByRole("button", { name: "纯文本" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("完成态按平台给不同的入口", () => {
  // jsdom 既没有 navigator.clipboard 也没有 execCommand，复制会一路抛到 toast。
  // 这几条用例只关心菜单开合，给兜底那条路一个「成功了」的桩。
  beforeEach(() => {
    document.execCommand = vi.fn(() => true);
  });

  /** 复制菜单点开才挂内容，所以每条断言前先把它撑开。 */
  function openCopyMenu() {
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
  }

  it("公众号给的是 HTML 正文那一套：复制正文、复制摘要、摘要格、右侧配图素材", async () => {
    await renderStudio(project());

    expect(screen.getByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "配图素材" })).toBeInTheDocument();

    openCopyMenu();
    expect(screen.getByRole("button", { name: "一键复制到公众号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制摘要" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制文案" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制标签" })).toBeNull();

    // 选完一项菜单要自己收起来。复制本身是异步的，等它落地再断言，免得 act 告警
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制标题" }));
    });
    expect(screen.getByRole("button", { name: "复制" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "复制标题" })).toBeNull();

    // 标题与摘要两格只在编辑态露出来，预览态里标题是渲好的 <h1>
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("图文摘要")).toHaveValue("适合公众号摘要");
  });

  it("小红书换成文案与标签那一套，摘要与正文入口一个都不给", async () => {
    await renderStudio(project(XIAOHONGSHU));

    // 默认停在预览，文案与标签直接可见
    expect(screen.getByRole("button", { name: "预览" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/第一次用就回不去了。/)).toBeInTheDocument();
    expect(screen.getByText("#咖啡机")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "平台配图" })).toBeInTheDocument();

    openCopyMenu();
    expect(screen.getByRole("button", { name: "复制文案" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制标签" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "一键复制到公众号" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制摘要" })).toBeNull();
  });

  it("切到编辑才出现可改的文案框，caption 平台连摘要格都没有", async () => {
    await renderStudio(project(XIAOHONGSHU));
    expect(screen.queryByPlaceholderText("输入正文文案，换行会原样保留")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    expect(screen.getByRole("button", { name: "编辑" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "预览" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("图文标题")).toHaveValue("夏天必囤的咖啡机");
    expect(screen.queryByLabelText("图文摘要")).toBeNull();
    expect(screen.getByPlaceholderText("输入正文文案，换行会原样保留")).toHaveValue(
      "第一次用就回不去了。\n\n出杯快，清洗也简单。",
    );
  });
});
