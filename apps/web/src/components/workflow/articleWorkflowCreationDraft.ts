import type {
  ArticleWorkflowCreationConfig,
  ArticleWorkflowSourceFormat,
  ArticleWorkflowTopicStyle,
} from "@ai-assistant/article-workflow";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";

export type ArticleWorkflowCreationDraft =
  | {
      readonly mode: "source";
      readonly sourceFormat: ArticleWorkflowSourceFormat;
      readonly sourceText: string;
    }
  | {
      readonly mode: "topic";
      readonly topic: string;
      readonly keyPoints: string;
      readonly audience: string;
      readonly avoid: string;
      readonly style: ArticleWorkflowTopicStyle;
    };

export function defaultArticleWorkflowCreationDraft(mode: "source" | "topic" = "source"): ArticleWorkflowCreationDraft {
  return mode === "source"
    ? { mode: "source", sourceFormat: "plain-text", sourceText: "" }
    : {
        mode: "topic",
        topic: "",
        keyPoints: "",
        audience: "",
        avoid: "",
        style: { mode: "preset", preset: "general" },
      };
}

export function articleWorkflowCreationDraftFromProject(project: ArticleWorkflowProject): ArticleWorkflowCreationDraft {
  if (project.creationConfig.mode === "topic") {
    return {
      mode: "topic",
      topic: project.creationConfig.topic,
      keyPoints: project.creationConfig.keyPoints,
      audience: project.creationConfig.audience,
      avoid: project.creationConfig.avoid,
      style: project.creationConfig.style,
    };
  }
  return {
    mode: "source",
    sourceFormat: project.sourceFormat,
    sourceText: project.sourceText,
  };
}

export function articleWorkflowCreationConfigFromDraft(
  draft: ArticleWorkflowCreationDraft,
  generateImages: boolean,
): ArticleWorkflowCreationConfig {
  return draft.mode === "source"
    ? { mode: "source", generateImages }
    : { ...draft, generateImages };
}

export function canSubmitArticleWorkflowCreationDraft(draft: ArticleWorkflowCreationDraft): boolean {
  if (draft.mode === "source") return draft.sourceText.trim().length > 0;
  if (!draft.topic.trim()) return false;
  if (draft.style.mode === "custom") return draft.style.instruction.trim().length > 0;
  if (draft.style.mode === "imitate") return draft.style.referenceText.trim().length > 0;
  return true;
}
