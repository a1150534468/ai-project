import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleWorkflowCreationCanvas } from "./ArticleWorkflowCreationCanvas";
import {
  articleWorkflowCreationConfigFromDraft,
  articleWorkflowCreationDraftFromProject,
  canSubmitArticleWorkflowCreationDraft,
  defaultArticleWorkflowCreationDraft,
} from "./articleWorkflowCreationDraft";

describe("article workflow creation draft", () => {
  it("defaults source creation to text with images and topic creation to copy only", () => {
    const source = defaultArticleWorkflowCreationDraft("source");
    const topic = defaultArticleWorkflowCreationDraft("topic");

    expect(source).toEqual({ mode: "source", sourceFormat: "plain-text", sourceText: "" });
    expect(topic).toEqual(expect.objectContaining({
      mode: "topic",
      topic: "",
      style: { mode: "preset", preset: "general" },
    }));
    expect(articleWorkflowCreationConfigFromDraft(source, true)).toEqual({
      mode: "source",
      generateImages: true,
    });
    expect(articleWorkflowCreationConfigFromDraft(topic, false)).toEqual(expect.objectContaining({
      mode: "topic",
      generateImages: false,
    }));
  });

  it("requires topic plus the active custom or imitation field", () => {
    expect(canSubmitArticleWorkflowCreationDraft({
      ...defaultArticleWorkflowCreationDraft("topic") as Extract<ReturnType<typeof defaultArticleWorkflowCreationDraft>, { mode: "topic" }>,
      topic: "冰咖啡",
    })).toBe(true);
    expect(canSubmitArticleWorkflowCreationDraft({
      mode: "topic",
      topic: "冰咖啡",
      keyPoints: "",
      audience: "",
      avoid: "",
      style: { mode: "custom", instruction: "" },
    })).toBe(false);
    expect(canSubmitArticleWorkflowCreationDraft({
      mode: "topic",
      topic: "冰咖啡",
      keyPoints: "",
      audience: "",
      avoid: "",
      style: { mode: "imitate", referenceText: "参考表达" },
    })).toBe(true);
  });

  it("hydrates the full saved topic config for history selection", () => {
    const draft = articleWorkflowCreationDraftFromProject({
      creationMode: "topic",
      creationConfig: {
        mode: "topic",
        generateImages: false,
        topic: "冰咖啡",
        keyPoints: "控制浓度",
        audience: "新手",
        avoid: "不夸大",
        style: { mode: "imitate", referenceText: "参考文案" },
      },
      sourceFormat: "plain-text",
      sourceText: "规范化简报",
    } as never);

    expect(draft).toEqual({
      mode: "topic",
      topic: "冰咖啡",
      keyPoints: "控制浓度",
      audience: "新手",
      avoid: "不夸大",
      style: { mode: "imitate", referenceText: "参考文案" },
    });
  });

  it("renders presets and keeps optional brief fields under more settings", () => {
    const html = renderToStaticMarkup(
      <ArticleWorkflowCreationCanvas
        draft={{
          mode: "topic",
          topic: "冰咖啡",
          keyPoints: "",
          audience: "",
          avoid: "",
          style: { mode: "preset", preset: "general" },
        }}
        onChange={() => undefined}
        onModeChange={() => undefined}
      />,
    );

    expect(html).toContain("原文改编");
    expect(html).toContain("主题创作");
    expect(html).toContain("经验分享");
    expect(html).toContain("种草推荐");
    expect(html).toContain("教程攻略");
    expect(html).toContain("观点表达");
    expect(html).toContain("情感治愈");
    expect(html).toContain("更多设置");
    expect(html.indexOf("更多设置")).toBeLessThan(html.indexOf("核心要点"));
  });
});
