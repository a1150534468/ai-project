import { createHash } from "node:crypto";
import type { NovelVectorDocument, NovelVectorStore } from "./novel-vector-types.js";

const INDEX_CONTENT_LIMIT = 3_200;

export function compactNovelVectorText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const characters = [...compact];
  return characters.length <= maxChars ? compact : `${characters.slice(0, maxChars).join("")}...`;
}

function stableJsonText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function vectorDocument(
  candidate: Omit<NovelVectorDocument, "contentHash">,
): NovelVectorDocument | null {
  const content = compactNovelVectorText(candidate.content, INDEX_CONTENT_LIMIT);
  if (!content) return null;
  const contentHash = createHash("sha256").update(content).digest("hex");
  return { ...candidate, content, contentHash };
}

function nonEmptyDocuments(
  candidates: readonly (NovelVectorDocument | null)[],
): NovelVectorDocument[] {
  return candidates.filter((item): item is NovelVectorDocument => item !== null);
}

export async function loadNovelVectorDocuments(
  store: NovelVectorStore,
  projectId: string,
): Promise<NovelVectorDocument[]> {
  const [project, bible, worlds, styles, characters, locations, storylines, chapters] = await Promise.all([
    store.novelProject.findUnique({ where: { id: projectId } }),
    store.novelBible.findUnique({ where: { projectId } }),
    store.novelWorldDimension.findMany({ where: { projectId }, orderBy: { position: "asc" } }),
    store.novelStyleNote.findMany({ where: { projectId }, orderBy: { position: "asc" } }),
    store.novelCharacter.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
    store.novelLocation.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
    store.novelStoryline.findMany({
      where: { projectId },
      include: { milestones: { orderBy: { chapterNumber: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
    store.novelChapter.findMany({ where: { projectId }, orderBy: { chapterIndex: "asc" } }),
  ]);

  const candidates: Array<NovelVectorDocument | null> = [];
  if (project) {
    const settings = stableJsonText(project.settings);
    const contract = stableJsonText(project.narrativeContract);
    candidates.push(vectorDocument({
      sourceType: "bible",
      sourceId: project.id,
      sourceKind: "story-contract",
      title: "故事圣经与叙事契约",
      content: [
        `【故事圣经】\n书名：${project.title}`,
        project.genre && `题材：${project.genre}`,
        project.premise && `核心梗概：${project.premise}`,
        settings && `项目设置：${settings}`,
        contract && `叙事契约：${contract}`,
      ].filter(Boolean).join("\n"),
    }));
  }
  if (bible) {
    candidates.push(vectorDocument({
      sourceType: "bible",
      sourceId: bible.id,
      sourceKind: "locked-foundation",
      title: "锁定设定",
      content: `【锁定设定】\n故事前提：${bible.premiseLock}\n题材：${bible.genreLock}\n世界预设：${bible.worldPresetLock}`,
    }));
  }

  candidates.push(...worlds.map((item) => vectorDocument({
    sourceType: "world",
    sourceId: item.id,
    sourceKind: item.dimensionKey,
    title: item.title,
    content: `【世界维度·${item.title}】\n${item.summary}\n${stableJsonText(item.details)}`,
  })));
  candidates.push(...styles.map((item) => vectorDocument({
    sourceType: "style",
    sourceId: item.id,
    sourceKind: item.category,
    title: item.title,
    content: `【文风公约·${item.title}】\n${item.content}`,
  })));
  candidates.push(...characters.map((item) => vectorDocument({
    sourceType: "character",
    sourceId: item.id,
    sourceKind: item.role || "character",
    title: item.name,
    content: [
      `【人物·${item.name}】`,
      item.role && `角色定位：${item.role}`,
      item.description && `人物简介：${item.description}`,
      item.appearance && `外貌：${item.appearance}`,
      item.personality && `性格：${item.personality}`,
      item.coreBelief && `核心信念：${item.coreBelief}`,
      item.coreMotivation && `核心动机：${item.coreMotivation}`,
      item.innerLack && `内在缺失：${item.innerLack}`,
      item.voiceStyle && `语言风格：${item.voiceStyle}`,
      stableJsonText(item.state) && `当前状态：${stableJsonText(item.state)}`,
    ].filter(Boolean).join("\n"),
  })));
  candidates.push(...locations.map((item) => vectorDocument({
    sourceType: "location",
    sourceId: item.id,
    sourceKind: "location",
    title: item.name,
    content: `【地点·${item.name}】\n${item.description}\n规则：${item.rules}\n${stableJsonText(item.metadata)}`,
  })));
  candidates.push(...storylines.map((item) => vectorDocument({
    sourceType: "storyline",
    sourceId: item.id,
    sourceKind: item.storylineType,
    title: item.title,
    content: [
      `【故事线·${item.title}】`,
      `类型：${item.storylineType}；状态：${item.status}`,
      item.goal && `目标：${item.goal}`,
      item.conflict && `冲突：${item.conflict}`,
      item.milestones.length && `里程碑：\n${item.milestones.map((milestone) => (
        `第${milestone.chapterNumber}章 ${milestone.title}：${milestone.description}`
      )).join("\n")}`,
    ].filter(Boolean).join("\n"),
  })));
  candidates.push(...chapters.filter((chapter) => chapter.content.trim()).map((chapter) => {
    const title = `第 ${chapter.chapterIndex} 章 ${chapter.title.trim() || "未命名"}`;
    const summary = chapter.summary.trim()
      ? `摘要：${compactNovelVectorText(chapter.summary, 500)}\n`
      : "";
    return vectorDocument({
      sourceType: "chapter",
      sourceId: chapter.id,
      sourceKind: `chapter:${chapter.chapterIndex}`,
      title,
      content: `【前文正文】\n${title}\n${summary}正文：${chapter.content}`,
    });
  }));

  return nonEmptyDocuments(candidates);
}
