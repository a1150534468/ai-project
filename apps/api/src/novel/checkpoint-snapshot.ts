import { Prisma, type PrismaClient } from "@prisma/client";

type SnapshotStore = PrismaClient | Prisma.TransactionClient;

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function dataRows<T>(value: unknown, projectId: string): T[] {
  return rows(value).map((row) => ({ ...row, projectId })) as T[];
}

export async function captureNovelStructuredSnapshot(store: SnapshotStore, projectId: string) {
  const [bible, worldDimensions, styleNotes, structureNodes, characters, characterRelations, locations, timelineEvents, storylines, storylineMilestones, props, propEvents, narrativeEvents, causalEdges, narrativeDebts, entityStates, knowledgeFacts, foreshadowItems, foreshadowEvents] = await Promise.all([
    store.novelBible.findUnique({ where: { projectId }, select: { id: true, premiseLock: true, genreLock: true, worldPresetLock: true, version: true } }),
    store.novelWorldDimension.findMany({ where: { projectId }, select: { id: true, bibleId: true, dimensionKey: true, title: true, summary: true, details: true, position: true } }),
    store.novelStyleNote.findMany({ where: { projectId }, select: { id: true, bibleId: true, category: true, title: true, content: true, position: true } }),
    store.novelStructureNode.findMany({ where: { projectId }, select: { id: true, parentId: true, nodeType: true, title: true, description: true, number: true, startChapter: true, endChapter: true, outline: true, metadata: true } }),
    store.novelCharacter.findMany({ where: { projectId }, select: { id: true, name: true, role: true, gender: true, age: true, description: true, appearance: true, personality: true, publicProfile: true, coreBelief: true, coreMotivation: true, innerLack: true, moralTaboos: true, voiceStyle: true, state: true } }),
    store.novelCharacterRelation.findMany({ where: { projectId }, select: { id: true, fromCharacterId: true, toCharacterId: true, relationType: true, description: true, strength: true, state: true } }),
    store.novelLocation.findMany({ where: { projectId }, select: { id: true, name: true, description: true, rules: true, metadata: true } }),
    store.novelTimelineEvent.findMany({ where: { projectId }, select: { id: true, chapterNumber: true, timeLabel: true, title: true, description: true, participants: true, source: true, sourceKey: true } }),
    store.novelStoryline.findMany({ where: { projectId }, select: { id: true, title: true, storylineType: true, status: true, goal: true, conflict: true, promiseTags: true, aliases: true } }),
    store.novelStorylineMilestone.findMany({ where: { projectId }, select: { id: true, storylineId: true, chapterNumber: true, title: true, description: true, status: true } }),
    store.novelProp.findMany({ where: { projectId }, select: { id: true, name: true, description: true, owner: true, location: true, status: true, metadata: true, source: true } }),
    store.novelPropEvent.findMany({ where: { projectId }, select: { id: true, propId: true, chapterNumber: true, eventType: true, description: true, stateAfter: true, source: true, sourceKey: true } }),
    store.novelNarrativeEvent.findMany({ where: { projectId }, select: { id: true, chapterNumber: true, eventType: true, title: true, description: true, actors: true, locations: true, tags: true, tension: true } }),
    store.novelCausalEdge.findMany({ where: { projectId }, select: { id: true, fromEventId: true, toEventId: true, relationType: true, confidence: true, evidence: true } }),
    store.novelNarrativeDebt.findMany({ where: { projectId }, select: { id: true, debtType: true, title: true, description: true, introducedChapter: true, dueChapter: true, status: true, severity: true, foreshadowId: true, resolvedInChapter: true, resolutionEvidence: true, source: true, sourceKey: true } }),
    store.novelEntityState.findMany({ where: { projectId }, select: { id: true, entityType: true, entityKey: true, chapterNumber: true, state: true, sourceExcerpt: true } }),
    store.novelKnowledgeFact.findMany({ where: { projectId }, select: { id: true, chapterIndex: true, subject: true, predicate: true, object: true, sourceExcerpt: true, confidence: true, status: true } }),
    store.novelForeshadowItem.findMany({ where: { projectId }, select: { id: true, introducedInChapterIndex: true, title: true, description: true, expectedPayoffChapter: true, status: true, relatedCharacter: true, source: true, sourceKey: true, lastMentionedChapter: true, resolvedInChapterIndex: true, resolutionEvidence: true } }),
    store.novelForeshadowEvent.findMany({ where: { projectId }, select: { id: true, foreshadowId: true, chapterIndex: true, action: true, evidence: true, confidence: true, source: true, sourceKey: true } }),
  ]);
  return { bible, worldDimensions, styleNotes, structureNodes, characters, characterRelations, locations, timelineEvents, storylines, storylineMilestones, props, propEvents, narrativeEvents, causalEdges, narrativeDebts, entityStates, knowledgeFacts, foreshadowItems, foreshadowEvents };
}

export async function restoreNovelStructuredSnapshot(tx: Prisma.TransactionClient, projectId: string, value: unknown): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const snapshot = value as Record<string, unknown>;
  await Promise.all([
    tx.novelWorldDimension.deleteMany({ where: { projectId } }),
    tx.novelStyleNote.deleteMany({ where: { projectId } }),
    tx.novelCharacterRelation.deleteMany({ where: { projectId } }),
    tx.novelStorylineMilestone.deleteMany({ where: { projectId } }),
    tx.novelPropEvent.deleteMany({ where: { projectId } }),
    tx.novelCausalEdge.deleteMany({ where: { projectId } }),
    tx.novelForeshadowEvent.deleteMany({ where: { projectId } }),
  ]);
  await Promise.all([
    tx.novelStructureNode.deleteMany({ where: { projectId } }),
    tx.novelCharacter.deleteMany({ where: { projectId } }),
    tx.novelLocation.deleteMany({ where: { projectId } }),
    tx.novelTimelineEvent.deleteMany({ where: { projectId } }),
    tx.novelStoryline.deleteMany({ where: { projectId } }),
    tx.novelProp.deleteMany({ where: { projectId } }),
    tx.novelNarrativeEvent.deleteMany({ where: { projectId } }),
    tx.novelNarrativeDebt.deleteMany({ where: { projectId } }),
    tx.novelEntityState.deleteMany({ where: { projectId } }),
    tx.novelKnowledgeFact.deleteMany({ where: { projectId } }),
    tx.novelForeshadowItem.deleteMany({ where: { projectId } }),
    tx.novelBible.deleteMany({ where: { projectId } }),
  ]);
  const create = async <T>(items: T[], writer: { createMany: (args: { data: T[] }) => Promise<unknown> }) => {
    if (items.length) await writer.createMany({ data: items });
  };
  const bibleSnapshot = snapshot.bible && typeof snapshot.bible === "object" && !Array.isArray(snapshot.bible) ? snapshot.bible as Record<string, unknown> : null;
  const bible = bibleSnapshot ? await tx.novelBible.create({ data: {
    ...(bibleSnapshot.id ? { id: String(bibleSnapshot.id) } : {}),
    projectId,
    premiseLock: String(bibleSnapshot.premiseLock ?? ""),
    genreLock: String(bibleSnapshot.genreLock ?? ""),
    worldPresetLock: String(bibleSnapshot.worldPresetLock ?? ""),
    version: Number(bibleSnapshot.version ?? 1) || 1,
  } }) : null;
  if (bible) {
    await Promise.all([
      create(dataRows<Prisma.NovelWorldDimensionCreateManyInput>(snapshot.worldDimensions, projectId).map((row) => ({ ...row, bibleId: bible.id })), tx.novelWorldDimension),
      create(dataRows<Prisma.NovelStyleNoteCreateManyInput>(snapshot.styleNotes, projectId).map((row) => ({ ...row, bibleId: bible.id })), tx.novelStyleNote),
    ]);
  }
  await create(dataRows<Prisma.NovelStructureNodeCreateManyInput>(snapshot.structureNodes, projectId), tx.novelStructureNode);
  await Promise.all([
    create(dataRows<Prisma.NovelCharacterCreateManyInput>(snapshot.characters, projectId), tx.novelCharacter),
    create(dataRows<Prisma.NovelLocationCreateManyInput>(snapshot.locations, projectId), tx.novelLocation),
    create(dataRows<Prisma.NovelTimelineEventCreateManyInput>(snapshot.timelineEvents, projectId), tx.novelTimelineEvent),
    create(dataRows<Prisma.NovelStorylineCreateManyInput>(snapshot.storylines, projectId), tx.novelStoryline),
    create(dataRows<Prisma.NovelPropCreateManyInput>(snapshot.props, projectId), tx.novelProp),
    create(dataRows<Prisma.NovelNarrativeEventCreateManyInput>(snapshot.narrativeEvents, projectId), tx.novelNarrativeEvent),
    create(dataRows<Prisma.NovelEntityStateCreateManyInput>(snapshot.entityStates, projectId), tx.novelEntityState),
    create(dataRows<Prisma.NovelKnowledgeFactCreateManyInput>(snapshot.knowledgeFacts, projectId), tx.novelKnowledgeFact),
    create(dataRows<Prisma.NovelForeshadowItemCreateManyInput>(snapshot.foreshadowItems, projectId), tx.novelForeshadowItem),
  ]);
  await Promise.all([
    create(dataRows<Prisma.NovelNarrativeDebtCreateManyInput>(snapshot.narrativeDebts, projectId), tx.novelNarrativeDebt),
    create(dataRows<Prisma.NovelForeshadowEventCreateManyInput>(snapshot.foreshadowEvents, projectId), tx.novelForeshadowEvent),
  ]);
  await Promise.all([
    create(dataRows<Prisma.NovelCharacterRelationCreateManyInput>(snapshot.characterRelations, projectId), tx.novelCharacterRelation),
    create(dataRows<Prisma.NovelStorylineMilestoneCreateManyInput>(snapshot.storylineMilestones, projectId), tx.novelStorylineMilestone),
    create(dataRows<Prisma.NovelPropEventCreateManyInput>(snapshot.propEvents, projectId), tx.novelPropEvent),
    create(dataRows<Prisma.NovelCausalEdgeCreateManyInput>(snapshot.causalEdges, projectId), tx.novelCausalEdge),
  ]);
}

// ---------------------------------------------------------------------------
// 增量检查点（snapshot v2）：旧格式每存一次检查点就把整本书正文塞进一行 JSON，
// 第 N 章时累计写入量 ∝ N²。v2 约定：
// - 无父检查点（或父链起点）存全量：{ v: 2, project, chapters: [...], structured }
// - 有父检查点存差量：{ v: 2, project, chaptersDiff: { upserts, removedChapterIndexes }, structured }
//   upserts 是相对父检查点重建状态发生变化/新增的整行（按 chapterIndex 对齐），
//   removedChapterIndexes 是父状态里有、当前已删除的章号。
// - project 与 structured 仍存全量：project 是小字段；structured 是结构元数据
//   （不是正文，N² 膨胀来自 chapters 的 content/rawContent），本轮不做增量。
// 读取侧统一走 resolveCheckpointChapters 沿 parentId 父链重建，与旧格式
// （无 v 字段、直接带 chapters 数组）完全兼容——旧检查点本身就是链上的全量基底。
// ---------------------------------------------------------------------------

export interface CheckpointChaptersDiff {
  readonly upserts: Record<string, unknown>[];
  readonly removedChapterIndexes: number[];
}

function snapshotRecordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function chapterIndexOf(row: Record<string, unknown>): number {
  const value = row.chapterIndex;
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function chaptersByIndex(list: readonly Record<string, unknown>[]): Map<number, Record<string, unknown>> {
  const map = new Map<number, Record<string, unknown>>();
  for (const row of list) map.set(chapterIndexOf(row), row);
  return map;
}

/** 相对父状态算章级差量：行内容逐字 JSON 对比（两侧都来自 DB 读取，键序一致）。 */
export function diffCheckpointChapters(
  parentChapters: readonly Record<string, unknown>[],
  currentChapters: readonly Record<string, unknown>[],
): CheckpointChaptersDiff {
  const parentByIndex = chaptersByIndex(parentChapters);
  const currentByIndex = chaptersByIndex(currentChapters);
  const upserts: Record<string, unknown>[] = [];
  for (const [index, row] of currentByIndex) {
    const before = parentByIndex.get(index);
    if (!before || JSON.stringify(before) !== JSON.stringify(row)) upserts.push(row);
  }
  const removedChapterIndexes: number[] = [];
  for (const index of parentByIndex.keys()) {
    if (!currentByIndex.has(index)) removedChapterIndexes.push(index);
  }
  return { upserts, removedChapterIndexes };
}

export function applyCheckpointChaptersDiff(
  baseChapters: readonly Record<string, unknown>[],
  diff: CheckpointChaptersDiff,
): Record<string, unknown>[] {
  const byIndex = chaptersByIndex(baseChapters);
  for (const index of diff.removedChapterIndexes) byIndex.delete(index);
  for (const row of diff.upserts) byIndex.set(chapterIndexOf(row), row);
  return [...byIndex.values()].sort((a, b) => chapterIndexOf(a) - chapterIndexOf(b));
}

function readChaptersDiff(value: unknown): CheckpointChaptersDiff | null {
  const record = snapshotRecordOf(value);
  if (!record) return null;
  return {
    upserts: rows(record.upserts),
    removedChapterIndexes: Array.isArray(record.removedChapterIndexes)
      ? record.removedChapterIndexes.filter((item): item is number => typeof item === "number" && Number.isFinite(item)).map((item) => Math.round(item))
      : [],
  };
}

/** 快照里直接带全量 chapters 的（旧格式 / v2 全量）取出章节；增量格式返回 null。 */
export function directCheckpointChapters(snapshot: unknown): Record<string, unknown>[] | null {
  const record = snapshotRecordOf(snapshot);
  if (!record || !Array.isArray(record.chapters)) return null;
  return rows(record.chapters);
}

export function buildCheckpointSnapshot(args: {
  readonly project: Record<string, unknown>;
  readonly chapters: readonly Record<string, unknown>[];
  readonly structured: unknown;
  /** 父检查点的重建后章节；null 表示没有父检查点，本条存全量。 */
  readonly parentChapters: readonly Record<string, unknown>[] | null;
  readonly extra?: Record<string, unknown>;
}): Record<string, unknown> {
  if (!args.parentChapters) {
    return { ...args.extra, v: 2, project: args.project, chapters: [...args.chapters], structured: args.structured };
  }
  return {
    ...args.extra,
    v: 2,
    project: args.project,
    chaptersDiff: diffCheckpointChapters(args.parentChapters, args.chapters),
    structured: args.structured,
  };
}

/** 分支检查点：状态与源检查点完全一致，存空差量、父链指向源检查点即可，不再整本复制。 */
export function buildCheckpointBranchSnapshot(sourceSnapshot: unknown): Record<string, unknown> {
  const source = snapshotRecordOf(sourceSnapshot);
  return {
    v: 2,
    project: source?.project ?? {},
    chaptersDiff: { upserts: [], removedChapterIndexes: [] },
    structured: source?.structured ?? null,
  };
}

interface CheckpointChainNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly snapshot: unknown;
}

const MAX_CHECKPOINT_CHAIN = 1000;

/**
 * 把任意检查点（旧全量 / v2 全量 / v2 增量）重建为完整章节数组：
 * 沿 parentId 向上走到最近的全量基底，再把链上的差量逐层正向应用。
 * 父链断裂（父行缺失/环/增量没有全量祖先）直接抛错——宁可让回滚失败，
 * 也不能拿错状态覆盖正文。
 */
export async function resolveCheckpointChapters(
  store: SnapshotStore,
  checkpoint: CheckpointChainNode,
): Promise<Record<string, unknown>[]> {
  const direct = directCheckpointChapters(checkpoint.snapshot);
  if (direct) return direct;
  const diffs: CheckpointChaptersDiff[] = [];
  let cursor: CheckpointChainNode = checkpoint;
  for (let depth = 0; depth < MAX_CHECKPOINT_CHAIN; depth += 1) {
    const record = snapshotRecordOf(cursor.snapshot);
    const diff = record ? readChaptersDiff(record.chaptersDiff) : null;
    if (!diff) throw new Error(`检查点 ${cursor.id} 的快照既没有全量 chapters 也没有合法的 chaptersDiff，无法重建`);
    diffs.push(diff);
    if (!cursor.parentId) throw new Error(`检查点 ${cursor.id} 是增量格式但父链上没有全量基底，无法重建`);
    const parent = await store.novelCheckpoint.findFirst({
      where: { id: cursor.parentId },
      select: { id: true, parentId: true, snapshot: true },
    });
    if (!parent) throw new Error(`检查点 ${cursor.id} 的父检查点 ${cursor.parentId} 不存在，父链断裂`);
    const parentDirect = directCheckpointChapters(parent.snapshot);
    if (parentDirect) {
      let rebuilt = parentDirect;
      for (const item of diffs.reverse()) rebuilt = applyCheckpointChaptersDiff(rebuilt, item);
      return rebuilt;
    }
    cursor = parent;
  }
  throw new Error(`检查点 ${checkpoint.id} 的父链超过 ${MAX_CHECKPOINT_CHAIN} 层，疑似成环，拒绝重建`);
}
