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
