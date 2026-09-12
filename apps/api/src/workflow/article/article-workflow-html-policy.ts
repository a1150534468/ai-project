import {
  ARTICLE_WORKFLOW_HTML_ATTRS,
  ARTICLE_WORKFLOW_HTML_BLOCKED_TAGS,
  ARTICLE_WORKFLOW_HTML_TAGS,
} from "@ai-assistant/article-workflow";

export const ARTICLE_HTML_TAGS = new Set(ARTICLE_WORKFLOW_HTML_TAGS);
export const ARTICLE_HTML_BLOCKED_TAGS = new Set(ARTICLE_WORKFLOW_HTML_BLOCKED_TAGS);
export const ARTICLE_HTML_ATTRIBUTES = new Set(ARTICLE_WORKFLOW_HTML_ATTRS);

export const ARTICLE_BLOCKED_STYLE_PROPERTIES = new Set([
  "position",
  "float",
  "clear",
  "z-index",
  "filter",
  "column-count",
  "column-gap",
  "columns",
  "transform",
  "animation",
]);

export const ARTICLE_FORBIDDEN_VISIBLE_PHRASES = [
  "当前项目直接复用",
  "编辑区只处理输入",
  "自动保存也只在内容真改动后触发",
  "这里看到的是最终要复制到公众号正文区的格式",
  "公众号图文工作流",
  "多平台图文工作流",
] as const;
