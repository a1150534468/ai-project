import { Prisma, type PrismaClient } from "@prisma/client";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const source = text(value);
  return source ? source.split(/\n{2,}|(?=第\s*\d+\s*[卷章幕])/u).map((item) => item.trim()).filter(Boolean) : [];
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return text(value) ? [text(value)] : [];
  return value.map(text).filter(Boolean);
}

function editablePlotVolumes(root: Record<string, unknown>): unknown[] {
  const generated = list(root.volumes ?? root["分卷"]);
  if (generated.length) return generated;
  const nodes = list(root.structure).map(object);
  const chapters = list(root.chapters).map(object);
  const chapterByNumber = new Map(chapters.map((chapter) => [number(chapter.chapterIndex ?? chapter.number), chapter]));
  const childrenOf = (parentId: unknown, nodeType: string) => nodes
    .filter((node) => text(node.parentId) === text(parentId) && text(node.nodeType) === nodeType)
    .sort((a, b) => number(a.number) - number(b.number));
  return nodes.filter((node) => text(node.nodeType) === "volume").sort((a, b) => number(a.number) - number(b.number)).map((volume) => ({
    number: number(volume.number, 1),
    title: text(volume.title),
    summary: text(volume.outline ?? volume.description),
    startChapter: number(volume.startChapter, 1),
    endChapter: number(volume.endChapter, 1),
    acts: childrenOf(volume.id, "act").map((act) => ({
      number: number(act.number, 1),
      title: text(act.title),
      summary: text(act.outline ?? act.description),
      chapters: childrenOf(act.id, "chapter").map((node) => {
        const chapterNumber = number(node.number, number(node.startChapter, 1));
        const chapter = chapterByNumber.get(chapterNumber) ?? {};
        const metadata = object(node.metadata);
        return {
          number: chapterNumber,
          title: text(chapter.title ?? node.title),
          outline: text(chapter.outline ?? chapter.summary ?? node.outline ?? node.description),
          goal: text(chapter.generationHint ?? metadata.goal),
          endingHook: text(metadata.endingHook),
          targetWords: number(metadata.targetWords),
        };
      }),
    })),
  }));
}

const WORLD_DIMENSIONS = [
  ["coreRules", "核心法则"],
  ["geography", "地理生态"],
  ["society", "社会结构"],
  ["culture", "历史文化"],
  ["dailyLife", "日常生活"],
] as const;

export async function syncNovelSetupAssets(args: {
  readonly prisma: PrismaClient;
  readonly projectId: string;
  readonly targetKind: "setupBible" | "setupCharacters" | "setupLocations" | "setupPlot";
  readonly value: unknown;
}): Promise<void> {
  const root = object(args.value);
  const project = await args.prisma.novelProject.findUniqueOrThrow({ where: { id: args.projectId } });

  if (args.targetKind === "setupBible") {
    const styleGuide = object(root.styleGuide ?? root.style_guide ?? root["文风公约"]);
    const worldbuilding = object(root.worldbuilding ?? root["世界观"]);
    const bible = await args.prisma.novelBible.upsert({
      where: { projectId: args.projectId },
      create: { projectId: args.projectId, premiseLock: project.premise, genreLock: project.genre, worldPresetLock: text(object(project.settings).worldPreset) },
      update: { premiseLock: project.premise, genreLock: project.genre, worldPresetLock: text(object(project.settings).worldPreset), version: { increment: 1 } },
    });
    await args.prisma.$transaction([
      args.prisma.novelWorldDimension.deleteMany({ where: { projectId: args.projectId } }),
      args.prisma.novelStyleNote.deleteMany({ where: { projectId: args.projectId } }),
    ]);
    for (let index = 0; index < WORLD_DIMENSIONS.length; index += 1) {
      const [dimensionKey, title] = WORLD_DIMENSIONS[index]!;
      const detail = object(worldbuilding[dimensionKey]);
      await args.prisma.novelWorldDimension.create({
        data: {
          projectId: args.projectId,
          bibleId: bible.id,
          dimensionKey,
          title,
          summary: text(detail.summary ?? detail.overview ?? worldbuilding[dimensionKey]),
          details: (Object.keys(detail).length ? detail : { content: worldbuilding[dimensionKey] ?? "" }) as Prisma.InputJsonValue,
          position: index,
        },
      });
    }
    const styleEntries = [
      ["narrativeVoice", "叙事声音"], ["sentenceRhythm", "句式节奏"], ["dialogue", "对话规则"],
      ["sensory", "感官密度"], ["avoid", "禁用写法"], ["sample", "风格样例"],
    ] as const;
    for (let index = 0; index < styleEntries.length; index += 1) {
      const [category, title] = styleEntries[index]!;
      const content = Array.isArray(styleGuide[category]) ? stringList(styleGuide[category]).join("\n") : text(styleGuide[category]);
      if (!content) continue;
      await args.prisma.novelStyleNote.create({ data: { projectId: args.projectId, bibleId: bible.id, category, title, content, position: index } });
    }
    await args.prisma.novelProject.update({ where: { id: args.projectId }, data: { setupStage: 2 } });
    return;
  }

  if (args.targetKind === "setupCharacters") {
    const rows = list(root.characters ?? root["人物"]);
    await args.prisma.novelCharacterRelation.deleteMany({ where: { projectId: args.projectId } });
    await args.prisma.novelCharacter.deleteMany({ where: { projectId: args.projectId } });
    const byName = new Map<string, string>();
    for (const candidate of rows) {
      const item = object(candidate);
      const name = text(item.name ?? item["姓名"]);
      if (!name) continue;
      const created = await args.prisma.novelCharacter.create({ data: {
        projectId: args.projectId,
        name,
        role: text(item.role ?? item["定位"]),
        gender: text(item.gender ?? item["性别"]),
        age: text(item.age ?? item["年龄"]),
        description: text(item.description ?? item["简介"]),
        appearance: text(item.appearance ?? item["外貌"]),
        personality: text(item.personality ?? item["性格"]),
        publicProfile: text(item.publicProfile ?? item["公开形象"]),
        coreBelief: text(item.coreBelief ?? item["核心信念"]),
        coreMotivation: text(item.coreMotivation ?? item["核心动机"]),
        innerLack: text(item.innerLack ?? item["内在缺口"]),
        moralTaboos: stringList(item.moralTaboos ?? item["道德禁区"]) as Prisma.InputJsonValue,
        voiceStyle: text(item.voiceStyle ?? item["声线"]),
      } });
      byName.set(name, created.id);
    }
    for (const candidate of list(root.relations ?? root["关系"] ?? root["人物关系"])) {
      const relation = object(candidate);
      const fromId = byName.get(text(relation.from ?? relation.fromName ?? relation["起点"]));
      const toId = byName.get(text(relation.to ?? relation.toName ?? relation["终点"]));
      if (!fromId || !toId || fromId === toId) continue;
      await args.prisma.novelCharacterRelation.create({ data: {
        projectId: args.projectId,
        fromCharacterId: fromId,
        toCharacterId: toId,
        relationType: text(relation.relationType ?? relation.type ?? relation["关系"]) || "关联",
        description: text(relation.description ?? relation["描述"]),
        strength: Math.max(0, Math.min(1, number(relation.strength, 0.5))),
      } });
    }
    await args.prisma.novelProject.update({ where: { id: args.projectId }, data: { setupStage: 3 } });
    return;
  }

  if (args.targetKind === "setupLocations") {
    await args.prisma.novelLocation.deleteMany({ where: { projectId: args.projectId } });
    for (const candidate of list(root.locations ?? root["地点"] ?? args.value)) {
      const location = object(candidate);
      const name = text(location.name ?? location["名称"]);
      if (!name) continue;
      await args.prisma.novelLocation.create({ data: {
        projectId: args.projectId,
        name,
        description: text(location.description ?? location["描述"]),
        rules: text(location.rules ?? location["规则"]),
        metadata: {
          region: text(location.region ?? location["区域"]),
          risk: text(location.risk ?? location["风险"]),
          narrativeFunction: text(location.narrativeFunction ?? location["叙事用途"]),
          connections: stringList(location.connections ?? location["连接"]),
        },
      } });
    }
    await args.prisma.novelProject.update({ where: { id: args.projectId }, data: { setupStage: 4 } });
    return;
  }

  await args.prisma.$transaction([
    args.prisma.novelStorylineMilestone.deleteMany({ where: { projectId: args.projectId } }),
    args.prisma.novelStoryline.deleteMany({ where: { projectId: args.projectId } }),
    args.prisma.novelStructureNode.deleteMany({ where: { projectId: args.projectId } }),
    args.prisma.novelChapter.deleteMany({ where: { projectId: args.projectId } }),
  ]);
  for (const candidate of list(root.storylines ?? root["故事线"])) {
    const line = object(candidate);
    const title = text(line.title ?? line["标题"]);
    if (!title) continue;
    const created = await args.prisma.novelStoryline.create({ data: {
      projectId: args.projectId,
      title,
      storylineType: text(line.storylineType ?? line.type ?? line["类型"]) || "main",
      goal: text(line.goal ?? line["目标"]),
      conflict: text(line.conflict ?? line["冲突"]),
      promiseTags: stringList(line.promiseTags ?? line["承诺标签"]) as Prisma.InputJsonValue,
    } });
    for (const milestoneCandidate of list(line.milestones ?? line["里程碑"])) {
      const milestone = object(milestoneCandidate);
      const chapterNumber = Math.max(1, number(milestone.chapterNumber ?? milestone["章节"], 1));
      await args.prisma.novelStorylineMilestone.create({ data: { projectId: args.projectId, storylineId: created.id, chapterNumber, title: text(milestone.title ?? milestone["标题"]) || `第${chapterNumber}章里程碑`, description: text(milestone.description ?? milestone["描述"]) } });
    }
  }
  const bookNode = await args.prisma.novelStructureNode.create({ data: { projectId: args.projectId, nodeType: "book", number: 1, title: project.title, description: project.premise, startChapter: 1, endChapter: project.targetChapters, outline: project.premise } });
  let nextChapterNumber = 1;
  for (const [volumeIndex, volumeCandidate] of editablePlotVolumes(root).entries()) {
    const volume = object(volumeCandidate);
    const volumeNumber = Math.max(1, number(volume.number, volumeIndex + 1));
    const volumeNode = await args.prisma.novelStructureNode.create({ data: { projectId: args.projectId, parentId: bookNode.id, nodeType: "volume", number: volumeNumber, title: text(volume.title) || `第${volumeNumber}卷`, description: text(volume.summary), startChapter: number(volume.startChapter, nextChapterNumber), endChapter: number(volume.endChapter, project.targetChapters), outline: text(volume.summary) } });
    const acts = list(volume.acts ?? volume["幕"]);
    for (const [actIndex, actCandidate] of acts.entries()) {
      const act = object(actCandidate);
      const actNumber = Math.max(1, number(act.number, actIndex + 1));
      const actNode = await args.prisma.novelStructureNode.create({ data: { projectId: args.projectId, parentId: volumeNode.id, nodeType: "act", number: actNumber, title: text(act.title) || `第${actNumber}幕`, description: text(act.summary), outline: text(act.summary) } });
      for (const chapterCandidate of list(act.chapters ?? act["章节"])) {
        const chapter = object(chapterCandidate);
        const chapterNumber = Math.max(nextChapterNumber, number(chapter.number, nextChapterNumber));
        const title = text(chapter.title) || `第 ${chapterNumber} 章`;
        const outline = text(chapter.outline ?? chapter.summary ?? chapter.goal);
        const metadata = { goal: text(chapter.goal), endingHook: text(chapter.endingHook), targetWords: number(chapter.targetWords, project.targetCharsPerChapter) };
        await args.prisma.novelStructureNode.create({ data: { projectId: args.projectId, parentId: actNode.id, nodeType: "chapter", number: chapterNumber, title, description: outline, startChapter: chapterNumber, endChapter: chapterNumber, outline, metadata } });
        await args.prisma.novelChapter.create({ data: { projectId: args.projectId, volumeIndex: volumeNumber, chapterIndex: chapterNumber, title, summary: outline, outline, generationHint: text(chapter.goal), status: "draft" } });
        nextChapterNumber = chapterNumber + 1;
      }
    }
  }
  await args.prisma.novelProject.update({ where: { id: args.projectId }, data: { setupStage: 5 } });
}
