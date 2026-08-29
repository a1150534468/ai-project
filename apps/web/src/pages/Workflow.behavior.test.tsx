// @vitest-environment jsdom

/**
 * `Workflow.tsx`(829 行)拆分前的行为护栏。P2.4 批次二 Step 1 的四类路径:渲染(模块分派 /
 * 页头 / 开发中占位)、切换(生图 Hub 的页内 tab 与后台开关)、提交(生图校验 → 下单 → 402)、
 * 错误态(拉取失败 / 上传参考图校验 / 取消与重试)。
 *
 * **和同目录 `Workflow.image-hub.test.tsx` 的分工是刻意的**:那个文件用真实 studio + stub fetch,
 * 断言的是 studio 内部渲染出的文案(tab 标签、算力点、下拉档位)。本文件相反 —— 把 11 个 studio
 * 全部换成探针,断言的是 **Workflow.tsx 自己算出来、往下传的那份 props**。拆分会把这段编排搬进
 * hook 或子组件,探针看到的 props 才是必须逐字不变的那个契约;studio 内部长什么样不是本文件的事。
 *
 * `imageStudioProps` 抓的是最后一次渲染的 props,回调直接从这里调用,不去 studio 里找按钮 ——
 * 否则断言会绑死在 studio 的 DOM 上,而 studio 恰恰是允许被改的那一侧。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowImageAsset, WorkflowImageTask } from "../api";
import { ToastProvider } from "../motion";
import Workflow from "./Workflow";

const apiMocks = vi.hoisted(() => ({
  cancelWorkflowImageTask: vi.fn(),
  generateWorkflowImages: vi.fn(),
  getImageWorkflowPricing: vi.fn(),
  getWorkflowImageState: vi.fn(),
  optimizeWorkflowPrompt: vi.fn(),
  uploadWorkflowImageReference: vi.fn(),
}));

/** 只替换 Workflow.tsx 真正调用的 6 个函数,其余(含 ApiError 之外的类型与工具)保持真实实现。 */
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...apiMocks,
}));

const probes = vi.hoisted(() => ({
  imageStudioProps: null as Record<string, any> | null,
  codexPetProps: null as Record<string, any> | null,
}));

function stub(testId: string) {
  return (props: Record<string, any>) => (
    <section data-testid={testId} data-token={String(props.token)} />
  );
}

vi.mock("../components/workflow/ImageWorkflowStudio", () => ({
  ImageWorkflowStudio: (props: Record<string, any>) => {
    probes.imageStudioProps = props;
    return (
      <section data-testid="image-studio">
        <p data-testid="image-error">{props.error}</p>
        <p data-testid="image-notice">{props.notice}</p>
        <p data-testid="image-prompt">{props.prompt}</p>
        <p data-testid="image-model">{props.model}</p>
        <p data-testid="image-size">{props.size}</p>
        <p data-testid="image-count">{props.countInput}</p>
        <p data-testid="image-mode">{props.workspaceMode}</p>
        <p data-testid="image-cost">{String(props.estimatedPointCost)}</p>
        <p data-testid="image-generating">{`${String(props.isGenerating)}/${props.generatingCount}`}</p>
        <p data-testid="image-tasks">{props.tasks.map((task: any) => `${task.id}:${task.status}`).join(",")}</p>
        <p data-testid="image-selected">{`${String(props.selectedRequestId)}|${String(props.selectedImageId)}`}</p>
        <p data-testid="image-refs">{props.referenceImages.map((asset: any) => asset.id).join(",")}</p>
        <p data-testid="image-cancelling">{props.cancellingTaskIds.join(",")}</p>
      </section>
    );
  },
}));

vi.mock("../components/workflow/CodexPetStudio", () => ({
  CodexPetStudio: (props: Record<string, any>) => {
    probes.codexPetProps = props;
    return <section data-testid="codex-pet-studio" data-project={String(props.initialProjectId)} />;
  },
}));

vi.mock("../components/workflow/CommerceImageStudio", () => ({ CommerceImageStudio: stub("commerce-studio") }));
vi.mock("../components/workflow/ComicWorkflowStudio", () => ({ ComicWorkflowStudio: stub("comic-studio") }));
vi.mock("../components/workflow/ArticleWorkflowStudio", () => ({ ArticleWorkflowStudio: stub("article-studio") }));
vi.mock("../components/workflow/ScheduledTaskStudio", () => ({ ScheduledTaskStudio: stub("scheduled-studio") }));
vi.mock("../components/workflow/PortraitWorkflowStudio", () => ({ PortraitWorkflowStudio: stub("portrait-studio") }));
vi.mock("../components/workflow/TryOnWorkflowStudio", () => ({ TryOnWorkflowStudio: stub("try-on-studio") }));
vi.mock("../components/workflow/NovelWorkflowStudio", () => ({ NovelWorkflowStudio: stub("novel-studio") }));
vi.mock("../components/workflow/LocalBusinessPromoWorkflowStudio", () => ({
  LocalBusinessPromoWorkflowStudio: stub("local-promo-studio"),
}));

function price(rate: number) {
  return { resourceKey: `image_${rate}`, displayName: "档位", pricingType: "PER_CALL" as const, rate, perUnits: 1, enabled: true };
}

function pricing(rate: number) {
  return { "1K": price(rate), "2K": price(rate * 2), "4K": price(rate * 4) };
}

function task(overrides: Partial<WorkflowImageTask> = {}): WorkflowImageTask {
  return {
    id: "db-1",
    requestId: "img-1",
    prompt: "历史任务提示词",
    model: "qwen-image-2.0-pro-2026-04-22",
    size: "1024x1024",
    referenceAssetIds: [],
    sourceImageAssetId: null,
    generationIntent: "new",
    count: 2,
    status: "running",
    completedCount: 0,
    error: null,
    createdAt: "2026-08-28T08:00:00Z",
    updatedAt: "2026-08-28T08:01:00Z",
    ...overrides,
  };
}

function asset(overrides: Partial<WorkflowImageAsset> = {}): WorkflowImageAsset {
  return {
    id: "asset-1",
    requestId: "img-1",
    requestIndex: 0,
    prompt: "历史任务提示词",
    model: "qwen-image-2.0-pro-2026-04-22",
    size: "1024x1024",
    originalUrl: "https://cdn.example.com/a.png",
    thumbnailUrl: "https://cdn.example.com/a-thumb.png",
    mime: "image/png",
    createdAt: "2026-08-28T08:02:00Z",
    ...overrides,
  };
}

type WorkflowOverrides = Partial<Parameters<typeof Workflow>[0]>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onBalanceRefresh: ReturnType<typeof vi.fn>;

async function mountWorkflow(overrides: WorkflowOverrides = {}): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <Workflow token="token" activeModuleId="image" onBalanceRefresh={onBalanceRefresh} {...overrides} />
      </ToastProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (!container) throw new Error("container missing");
  return container;
}

function probeText(scope: HTMLElement, testId: string): string {
  return scope.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

function imageProps(): Record<string, any> {
  if (!probes.imageStudioProps) throw new Error("ImageWorkflowStudio was never rendered");
  return probes.imageStudioProps;
}

/** 通过 studio 收到的回调驱动编排,再把 microtask 抽干。 */
async function invoke(run: (props: Record<string, any>) => unknown): Promise<void> {
  await act(async () => {
    await run(imageProps());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttons(scope: HTMLElement): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll("button"));
}

function tabButton(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = buttons(scope).find((button) => button.textContent?.trim() === label);
  if (!found) throw new Error(`tab "${label}" missing`);
  return found;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  probes.imageStudioProps = null;
  probes.codexPetProps = null;
  onBalanceRefresh = vi.fn();
  apiMocks.getWorkflowImageState.mockResolvedValue({ images: [], tasks: [] });
  apiMocks.getImageWorkflowPricing.mockResolvedValue(pricing(20));
  apiMocks.generateWorkflowImages.mockResolvedValue({ task: task({ status: "running" }), recent: [] });
  apiMocks.cancelWorkflowImageTask.mockResolvedValue(task({ status: "cancelled", error: "用户已取消" }));
  apiMocks.optimizeWorkflowPrompt.mockResolvedValue("优化后的提示词");
  apiMocks.uploadWorkflowImageReference.mockResolvedValue(asset({ id: "ref-1" }));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("Workflow 模块分派", () => {
  it("小说模块只挂 NovelWorkflowStudio，且不渲染模块页头", async () => {
    const scope = await mountWorkflow({ activeModuleId: "novel" });

    expect(scope.querySelector('[data-testid="novel-studio"]')).toBeTruthy();
    expect(scope.querySelector('[data-testid="image-studio"]')).toBeNull();
    expect(scope.querySelector("h1")).toBeNull();
    expect(scope.textContent).not.toContain("小说模块");
  });

  it("桌宠模块不渲染页头，并把 initialProjectId 与打开知识库文档的回调透传下去", async () => {
    const onOpenKnowledgeDocument = vi.fn();
    const scope = await mountWorkflow({
      activeModuleId: "codex-pet",
      initialCodexPetProjectId: "pet-42",
      onOpenKnowledgeDocument,
    });

    expect(scope.querySelector('[data-testid="codex-pet-studio"]')?.getAttribute("data-project")).toBe("pet-42");
    expect(scope.querySelector("h1")).toBeNull();
    expect(probes.codexPetProps?.token).toBe("token");
    expect(probes.codexPetProps?.onBalanceRefresh).toBe(onBalanceRefresh);
    expect(probes.codexPetProps?.onOpenKnowledgeDocument).toBe(onOpenKnowledgeDocument);
  });

  it("非全屏模块渲染页头：面包屑 + 标题 + 描述都取自 WORKFLOW_MODULES", async () => {
    const scope = await mountWorkflow({ activeModuleId: "scheduled-task" });

    expect(scope.textContent).toContain("工作流 / 定时任务");
    expect(scope.querySelector("h1")?.textContent).toBe("定时任务");
    expect(scope.textContent).toContain("定时运行、周期触发、结果追踪");
    expect(scope.querySelector('[data-testid="scheduled-studio"]')).toBeTruthy();
  });

  it.each([
    ["ai-comic", "comic-studio"],
    ["article-workflow", "article-studio"],
    ["local-business-promo", "local-promo-studio"],
  ] as const)("%s 分派到 %s", async (activeModuleId, testId) => {
    const scope = await mountWorkflow({ activeModuleId });
    expect(scope.querySelector(`[data-testid="${testId}"]`)).toBeTruthy();
  });

  it("未实现的模块落到「模块开发中」占位而不是空白", async () => {
    const scope = await mountWorkflow({ activeModuleId: "ppt" });

    expect(scope.textContent).toContain("模块开发中");
    expect(scope.querySelector('[data-testid="image-studio"]')).toBeNull();
  });
});

describe("Workflow 生图 Hub 的 tab 切换", () => {
  it("四个 studio 常驻 DOM，用 hidden 切换，切 tab 不卸载", async () => {
    const scope = await mountWorkflow({ activeModuleId: "image" });

    const wrapper = (testId: string) => scope.querySelector(`[data-testid="${testId}"]`)?.parentElement?.className ?? "";
    expect(wrapper("image-studio")).not.toBe("hidden");
    expect(wrapper("commerce-studio")).toBe("hidden");

    await act(async () => {
      tabButton(scope, "电商生图").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(wrapper("image-studio")).toBe("hidden");
    expect(wrapper("commerce-studio")).not.toBe("hidden");
    // 常驻意味着两边都还在 DOM 里，表单状态不会因为切 tab 丢失
    expect(scope.querySelector('[data-testid="image-studio"]')).toBeTruthy();
  });

  it("从电商入口进来默认停在电商 tab", async () => {
    const scope = await mountWorkflow({ activeModuleId: "commerce-long-image" });
    const wrapper = (testId: string) => scope.querySelector(`[data-testid="${testId}"]`)?.parentElement?.className ?? "";

    expect(wrapper("commerce-studio")).not.toBe("hidden");
    expect(wrapper("image-studio")).toBe("hidden");
  });

  it("后台只留一个 tab 时隐藏 tab 栏，其余 studio 不渲染", async () => {
    const scope = await mountWorkflow({
      activeModuleId: "image",
      menuVisibility: { "workflow.image.ecom": false, "workflow.image.portrait": false, "workflow.image.try-on": false },
    });

    expect(scope.querySelector('[data-testid="commerce-studio"]')).toBeNull();
    expect(scope.querySelector('[data-testid="portrait-studio"]')).toBeNull();
    expect(buttons(scope).some((button) => button.textContent?.trim() === "通用生图")).toBe(false);
    expect(scope.querySelector('[data-testid="image-studio"]')).toBeTruthy();
  });

  it("四个 tab 全被后台关掉时给出「生图模块暂未开放」", async () => {
    const scope = await mountWorkflow({
      activeModuleId: "image",
      menuVisibility: {
        "workflow.image.general": false,
        "workflow.image.ecom": false,
        "workflow.image.portrait": false,
        "workflow.image.try-on": false,
      },
    });

    expect(scope.textContent).toContain("生图模块暂未开放");
    expect(scope.querySelector('[data-testid="image-studio"]')).toBeNull();
  });
});

describe("Workflow 生图初始状态", () => {
  it("挂载时按 token 拉一次任务状态与当前模型的计价", async () => {
    const scope = await mountWorkflow();

    expect(apiMocks.getWorkflowImageState).toHaveBeenCalledWith("token");
    expect(apiMocks.getImageWorkflowPricing).toHaveBeenCalledWith("token", "qwen-image-2.0-pro-2026-04-22");
    // 默认 1 张 × 1K 20 点
    expect(probeText(scope, "image-cost")).toBe("20");
    expect(probeText(scope, "image-size")).toBe("1024x1024");
    expect(probeText(scope, "image-mode")).toBe("empty");
  });

  it("首屏有进行中的任务时自动选中它并进入结果态", async () => {
    apiMocks.getWorkflowImageState.mockResolvedValue({ images: [asset()], tasks: [task()] });
    const scope = await mountWorkflow();

    expect(probeText(scope, "image-tasks")).toBe("img-1:running");
    expect(probeText(scope, "image-selected")).toBe("img-1|asset-1");
    expect(probeText(scope, "image-mode")).toBe("result");
    // 2 张里 0 张完成 → 还差 2 张
    expect(probeText(scope, "image-generating")).toBe("true/2");
  });

  it("拉取任务状态失败只给一条提示，页面照常可用", async () => {
    apiMocks.getWorkflowImageState.mockRejectedValue(new Error("网关超时"));
    const scope = await mountWorkflow();

    expect(probeText(scope, "image-notice")).toBe("生图任务暂时无法加载");
    expect(scope.querySelector('[data-testid="image-studio"]')).toBeTruthy();
  });

  it("计价接口失败时预估留空而不是显示 0", async () => {
    apiMocks.getImageWorkflowPricing.mockRejectedValue(new Error("计价不可用"));
    const scope = await mountWorkflow();

    expect(probeText(scope, "image-cost")).toBe("null");
  });

  it("换模型会按新模型重新拉价，预估随之变化", async () => {
    apiMocks.getImageWorkflowPricing.mockImplementation(async (_token: string, model?: string) =>
      pricing(model === "gpt-image-2" ? 45 : 20));
    const scope = await mountWorkflow();
    expect(probeText(scope, "image-cost")).toBe("20");

    await invoke((props) => props.onModelChange("gpt-image-2"));

    expect(apiMocks.getImageWorkflowPricing).toHaveBeenLastCalledWith("token", "gpt-image-2");
    expect(probeText(scope, "image-cost")).toBe("45");
    expect(probeText(scope, "image-model")).toBe("gpt-image-2");
  });
});

describe("Workflow 生图提交", () => {
  it("提交带上完整参数，成功后刷新余额并把服务端任务合并进列表", async () => {
    apiMocks.generateWorkflowImages.mockResolvedValue({
      task: task({ requestId: "img-new", status: "running", count: 2 }),
      recent: [asset({ id: "asset-new", requestId: "img-new" })],
    });
    const scope = await mountWorkflow();

    await invoke((props) => props.onCountInputChange("2"));
    await invoke((props) => props.onPromptChange("  一只戴帽子的柴犬  "));
    await invoke((props) => props.onSubmit());

    expect(apiMocks.generateWorkflowImages).toHaveBeenCalledTimes(1);
    const [, payload] = apiMocks.generateWorkflowImages.mock.calls[0];
    expect(payload).toMatchObject({
      model: "qwen-image-2.0-pro-2026-04-22",
      prompt: "一只戴帽子的柴犬",
      size: "1024x1024",
      resolution: "1K",
      referenceAssetIds: [],
      generationIntent: "new",
      count: 2,
    });
    expect(String(payload.requestId)).toMatch(/^img-/);
    expect(onBalanceRefresh).toHaveBeenCalledTimes(1);
    expect(probeText(scope, "image-tasks")).toContain("img-new:running");
    expect(probeText(scope, "image-error")).toBe("");
  });

  it("提示词为空直接本地拦下，一个请求都不发", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onPromptChange("   "));
    await invoke((props) => props.onSubmit());

    expect(probeText(scope, "image-error")).toBe("请输入提示词");
    expect(apiMocks.generateWorkflowImages).not.toHaveBeenCalled();
  });

  it("张数不合法时报出校验原文，也不发请求", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onCountInputChange("零"));
    await invoke((props) => props.onSubmit());

    expect(probeText(scope, "image-error")).toBe("张数必须是整数");
    expect(apiMocks.generateWorkflowImages).not.toHaveBeenCalled();
  });

  it("402 被翻译成充值提示，且该任务标成 failed 而不是一直转圈", async () => {
    const { ApiError } = await import("../apiError");
    apiMocks.generateWorkflowImages.mockRejectedValue(new ApiError("insufficient points", 402));
    const scope = await mountWorkflow();

    await invoke((props) => props.onSubmit());

    expect(probeText(scope, "image-error")).toBe("积分不足，请充值");
    expect(probeText(scope, "image-tasks")).toContain(":failed");
    expect(onBalanceRefresh).not.toHaveBeenCalled();
  });

  it("非 402 的下单失败保留上游文案", async () => {
    apiMocks.generateWorkflowImages.mockRejectedValue(new Error("上游模型排队中"));
    const scope = await mountWorkflow();

    await invoke((props) => props.onSubmit());

    expect(probeText(scope, "image-error")).toBe("上游模型排队中");
  });

  it("快捷张数按钮改草稿并清掉上一条错误", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onCountInputChange("零"));
    await invoke((props) => props.onSubmit());
    expect(probeText(scope, "image-error")).toBe("张数必须是整数");

    await invoke((props) => props.onQuickCountChange(4));
    expect(probeText(scope, "image-count")).toBe("4");
    expect(probeText(scope, "image-error")).toBe("");
    expect(probeText(scope, "image-cost")).toBe("80");
  });
});

describe("Workflow 参考图上传", () => {
  function file(name: string, type: string, sizeBytes: number): File {
    const blob = new File(["x"], name, { type });
    Object.defineProperty(blob, "size", { value: sizeBytes });
    return blob;
  }

  it("上传成功后参考图进入草稿，并给出提示", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onReferenceUpload(file("ref.png", "image/png", 1024)));

    expect(apiMocks.uploadWorkflowImageReference).toHaveBeenCalledTimes(1);
    expect(probeText(scope, "image-refs")).toBe("ref-1");
    expect(probeText(scope, "image-notice")).toBe("参考图已上传，生成时将作为画面参考");
  });

  it("上传后的参考图会跟着下一次提交一起发出去", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onReferenceUpload(file("ref.png", "image/png", 1024)));
    await invoke((props) => props.onSubmit());

    expect(apiMocks.generateWorkflowImages.mock.calls[0][1]).toMatchObject({ referenceAssetIds: ["ref-1"] });
    expect(probeText(scope, "image-refs")).toBe("ref-1");
  });

  it("移除参考图后不再随提交发出", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onReferenceUpload(file("ref.png", "image/png", 1024)));
    await invoke((props) => props.onRemoveReference("ref-1"));
    expect(probeText(scope, "image-refs")).toBe("");

    await invoke((props) => props.onSubmit());
    expect(apiMocks.generateWorkflowImages.mock.calls[0][1]).toMatchObject({ referenceAssetIds: [] });
  });

  it("不支持的格式在本地就被拦下，不发上传请求", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onReferenceUpload(file("ref.pdf", "application/pdf", 1024)));

    expect(probeText(scope, "image-error")).toBe("参考图仅支持 JPG、PNG、WEBP、BMP、TIFF 或 GIF");
    expect(apiMocks.uploadWorkflowImageReference).not.toHaveBeenCalled();
  });

  it.each([
    ["超过 10MB", 10 * 1024 * 1024 + 1],
    ["空文件", 0],
  ] as const)("%s 的参考图被本地拦下", async (_case, sizeBytes) => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onReferenceUpload(file("ref.png", "image/png", sizeBytes)));

    expect(probeText(scope, "image-error")).toBe("参考图大小需在 10MB 以内");
    expect(apiMocks.uploadWorkflowImageReference).not.toHaveBeenCalled();
  });

  it("上传接口失败时报出上游文案，草稿里不留半个参考图", async () => {
    apiMocks.uploadWorkflowImageReference.mockRejectedValue(new Error("对象存储不可用"));
    const scope = await mountWorkflow();

    await invoke((props) => props.onReferenceUpload(file("ref.png", "image/png", 1024)));

    expect(probeText(scope, "image-error")).toBe("对象存储不可用");
    expect(probeText(scope, "image-refs")).toBe("");
  });
});

describe("Workflow 任务取消与重试", () => {
  it("取消先本地置为 cancelled，再落到服务端并刷新余额", async () => {
    apiMocks.getWorkflowImageState.mockResolvedValue({ images: [], tasks: [task()] });
    const scope = await mountWorkflow();

    await invoke((props) => props.onCancelTask(props.tasks[0]));

    expect(apiMocks.cancelWorkflowImageTask).toHaveBeenCalledWith("token", "img-1");
    expect(probeText(scope, "image-tasks")).toBe("img-1:cancelled");
    expect(probeText(scope, "image-notice")).toBe("已取消生图任务");
    expect(onBalanceRefresh).toHaveBeenCalledTimes(1);
    // 收尾后不留 in-flight 标记，按钮不会永久禁用
    expect(probeText(scope, "image-cancelling")).toBe("");
  });

  it("取消失败时报错并回读服务端状态，不把本地的乐观值留下", async () => {
    apiMocks.getWorkflowImageState
      .mockResolvedValueOnce({ images: [], tasks: [task()] })
      .mockResolvedValue({ images: [], tasks: [task({ status: "running" })] });
    apiMocks.cancelWorkflowImageTask.mockRejectedValue(new Error("任务已进入不可取消阶段"));
    const scope = await mountWorkflow();

    await invoke((props) => props.onCancelTask(props.tasks[0]));

    expect(probeText(scope, "image-error")).toBe("任务已进入不可取消阶段");
    expect(apiMocks.getWorkflowImageState).toHaveBeenCalledTimes(2);
    expect(probeText(scope, "image-tasks")).toBe("img-1:running");
    expect(probeText(scope, "image-cancelling")).toBe("");
  });

  it("已结束的任务点取消是空操作", async () => {
    apiMocks.getWorkflowImageState.mockResolvedValue({ images: [], tasks: [task({ status: "completed" })] });
    await mountWorkflow();

    await invoke((props) => props.onCancelTask(props.tasks[0]));

    expect(apiMocks.cancelWorkflowImageTask).not.toHaveBeenCalled();
  });

  it("重试按原任务参数重建请求，不读当前表单草稿", async () => {
    apiMocks.getWorkflowImageState.mockResolvedValue({
      images: [],
      tasks: [task({ status: "failed", error: "上游超时", prompt: "原任务提示词", size: "2048x1152", count: 3 })],
    });
    const scope = await mountWorkflow();

    await invoke((props) => props.onPromptChange("表单里被改过的提示词"));
    await invoke((props) => props.onRetryTask(props.tasks[0]));

    const [, payload] = apiMocks.generateWorkflowImages.mock.calls[0];
    // resolution 不在 task 上，是从 size 反解出来的（2048x1152 = 16:9 · 2K）
    expect(payload).toMatchObject({
      prompt: "原任务提示词",
      size: "2048x1152",
      resolution: "2K",
      count: 3,
      generationIntent: "new",
    });
    // 表单草稿不受重试影响
    expect(probeText(scope, "image-prompt")).toBe("表单里被改过的提示词");
    expect(onBalanceRefresh).toHaveBeenCalledTimes(1);
  });

  it("同一个失败任务连点重试只发一次请求", async () => {
    apiMocks.getWorkflowImageState.mockResolvedValue({ images: [], tasks: [task({ status: "failed" })] });
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    apiMocks.generateWorkflowImages.mockImplementation(async () => {
      await gate;
      return { task: task({ requestId: "img-retry", status: "running" }), recent: [] };
    });
    await mountWorkflow();

    const failed = imageProps().tasks[0];
    await invoke((props) => props.onRetryTask(failed));
    await invoke((props) => props.onRetryTask(failed));

    expect(apiMocks.generateWorkflowImages).toHaveBeenCalledTimes(1);
    await act(async () => { release?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  });
});

describe("Workflow 提示词优化与下载", () => {
  it("优化成功后回填提示词并提示", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onPromptChange("柴犬"));
    await invoke((props) => props.onOptimizePrompt());

    expect(apiMocks.optimizeWorkflowPrompt).toHaveBeenCalledWith("token", "柴犬");
    expect(probeText(scope, "image-prompt")).toBe("优化后的提示词");
    expect(probeText(scope, "image-notice")).toBe("提示词已优化");
  });

  it("提示词为空时不请求优化", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onPromptChange(" "));
    await invoke((props) => props.onOptimizePrompt());

    expect(apiMocks.optimizeWorkflowPrompt).not.toHaveBeenCalled();
    expect(probeText(scope, "image-error")).toBe("请输入提示词");
  });

  it("优化失败保留原提示词", async () => {
    apiMocks.optimizeWorkflowPrompt.mockRejectedValue(new Error("优化服务超时"));
    const scope = await mountWorkflow();

    await invoke((props) => props.onPromptChange("柴犬"));
    await invoke((props) => props.onOptimizePrompt());

    expect(probeText(scope, "image-error")).toBe("优化服务超时");
    expect(probeText(scope, "image-prompt")).toBe("柴犬");
  });

  it("批量下载弹出链接对话框，列出全部原图地址", async () => {
    apiMocks.getWorkflowImageState.mockResolvedValue({
      images: [asset(), asset({ id: "asset-2", originalUrl: "https://cdn.example.com/b.png" })],
      tasks: [task({ status: "completed", completedCount: 2 })],
    });
    const scope = await mountWorkflow();

    await invoke((props) => props.onDownloadAll());

    expect(scope.textContent).toContain("全部原图下载链接");
    expect(scope.textContent).toContain("https://cdn.example.com/a.png");
    expect(scope.textContent).toContain("https://cdn.example.com/b.png");
  });

  it("没有图片时批量下载不弹框", async () => {
    const scope = await mountWorkflow();

    await invoke((props) => props.onDownloadAll());

    expect(scope.textContent).not.toContain("全部原图下载链接");
  });
});
