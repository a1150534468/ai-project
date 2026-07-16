import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { deriveNovelChapterAssets } from "../workflow/novel-text-analysis.js";
import type { NovelEventCard } from "../workflow/novel-workbench-types.js";

export const AUTO_CONTINUITY_SOURCE = "chapterPostprocess";

const PROP_SUFFIXES = [
  "笔记本电脑", "管理员令牌", "机械键盘", "量子芯片", "文件袋", "门禁卡", "存储卡", "录音笔", "手提箱",
  "锁灵坠", "密信", "书信", "信件", "钥匙", "令牌", "玉佩", "吊坠", "戒指", "项链", "徽章", "芯片", "硬盘", "软盘", "U盘",
  "手机", "电脑", "平板", "服务器", "终端", "键盘", "鼠标", "耳机", "眼镜", "手环", "手表", "相机", "优盘", "银行卡",
  "卡片", "证件", "护照", "药剂", "药瓶", "药丸", "丹药", "卷轴", "地图", "照片", "档案", "文件", "合同", "笔记", "日记",
  "书册", "手册", "盒子", "箱子", "背包", "钱包", "匕首", "短剑", "长剑", "佩剑", "护符", "法器", "神器", "装置", "模块",
  "仪器", "遥控器", "密码本", "代码本", "印章", "皇冠", "权杖", "电池", "刀", "枪", "弓", "箭",
] as const;
const PROP_SUFFIX_PATTERN = [...PROP_SUFFIXES].sort((a, b) => b.length - a.length).join("|");
const PROP_END_RE = new RegExp(`(?:${PROP_SUFFIX_PATTERN})$`, "u");
const PROP_SCAN_RE = new RegExp(`[\\p{Script=Han}A-Za-z0-9·_-]{0,10}?(?:${PROP_SUFFIX_PATTERN})`, "gu");
const GENERIC_PROP_NAMES = new Set(["键盘", "终端", "眼镜", "芯片", "硬盘", "服务器", "文件", "档案", "钥匙", "刀", "枪", "弓", "箭"]);
const TIME_LABEL_RE = /(?:第[一二三四五六七八九十百千万0-9]+(?:年|月|日|天|周|小时|分钟)|[一二三四五六七八九十百千万0-9]+(?:年|个月|月|周|天|小时|分钟)(?:前|后)|当天|当日|次日|翌日|第二天|同一天|清晨|早晨|上午|中午|午后|下午|傍晚|晚上|夜里|深夜|凌晨)/u;
const DESTROYED_RE = /(摧毁|毁掉|毁坏|损毁|炸毁|烧毁|粉碎|碎裂|报废|失效)/u;
const LOST_RE = /(丢失|遗失|失踪|不见|遗落|被偷|偷走|抢走|夺走)/u;
const TRANSFER_RE = /(交给|递给|转交|归还|送给|移交|夺走|抢走|偷走)/u;
const ACQUIRE_RE = /(拿出|拿起|取出|掏出|捡起|拾起|收到|获得|得到|发现|找到|带着|携带|握着|戴上|戴着|装备)/u;
const USE_RE = /(使用|启动|打开|插入|连接|接入|解锁|激活|查看|读取|扫描|挥动|拔出|调出|按下|收起|装入|扯过|放回|举起|托起|取下)/u;
const NAME_BOUNDARIES = [
  "以及", "发现", "找到", "知道", "看见", "看到", "拿出", "拿起", "取出", "掏出", "捡起", "拾起", "收到", "获得", "得到",
  "使用", "启动", "打开", "插入", "连接", "接入", "摧毁", "毁掉", "丢失", "遗失", "交给", "递给", "转交", "归还", "送给", "携带",
  "拔出", "调出", "按下", "收起", "装入", "扯过", "放回", "举起", "托起", "取下",
  "握着", "戴上", "戴着", "装备", "一枚", "一把", "一张", "一块", "一个", "一台", "一部", "一件", "一只", "一串", "一份", "一幅",
  "那枚", "那把", "那张", "那块", "那个", "那台", "那部", "那件", "他的", "她的", "它的", "其", "的", "把", "将", "和", "与", "及", "从",
] as const;

export interface DerivedTimelineEvent {
  readonly timeLabel: string;
  readonly title: string;
  readonly description: string;
  readonly participants: string[];
}

export interface DerivedPropEvent {
  readonly name: string;
  readonly description: string;
  readonly owner: string;
  readonly location: string;
  readonly status: "active" | "lost" | "destroyed" | "retired";
  readonly eventType: "introduced" | "acquired" | "transferred" | "used" | "lost" | "destroyed" | "mentioned";
  readonly evidence: string;
}

export interface DerivedContinuityAssets {
  readonly timeline: DerivedTimelineEvent[];
  readonly props: DerivedPropEvent[];
}

type ContinuityStore = Pick<Prisma.TransactionClient, "novelTimelineEvent" | "novelProp" | "novelPropEvent">;

function stableHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function propName(value: string, knownCharacters: readonly string[], knownLocations: readonly string[]): string {
  let name = value.replace(/^[“”「」『』\s]+|[“”「」『』\s]+$/gu, "").trim();
  for (const boundary of NAME_BOUNDARIES) {
    const index = name.lastIndexOf(boundary);
    if (index >= 0) name = name.slice(index + boundary.length);
  }
  for (const entity of [...knownCharacters, ...knownLocations].sort((a, b) => b.length - a.length)) {
    if (name.startsWith(entity)) name = name.slice(entity.length);
  }
  name = name.replace(/^(?:了|着|到|过|的|被|从|在|向|给)+/u, "").trim();
  name = name
    .replace(/^用/u, "")
    .replace(/^(?:破旧|废弃|损坏|毁坏|碎裂|外壳碎裂|磨损严重|沾着血迹|生锈|旧式|古老|复古的?|高纯度)+/u, "")
    .replace(/^便携式/u, "便携")
    .trim();
  return name.length >= 2 && name.length <= 20 && PROP_END_RE.test(name) ? name : "";
}

function inferOwner(sentence: string, name: string, characters: readonly string[]): string {
  for (const character of characters) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const escapedCharacter = character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`${escapedName}.{0,8}(?:交给|递给|转交给|归还给|送给|留给)${escapedCharacter}`, "u").test(sentence)) return character;
    if (new RegExp(`${escapedCharacter}.{0,8}(?:拿出|拿起|取出|掏出|捡起|拾起|收到|获得|得到|带着|携带|握着|戴上|戴着|使用|启动).{0,4}${escapedName}`, "u").test(sentence)) return character;
    if (sentence.includes(`${character}的${name}`)) return character;
  }
  const mentioned = characters.filter((character) => sentence.includes(character));
  return mentioned.length === 1 && (ACQUIRE_RE.test(sentence) || USE_RE.test(sentence)) ? mentioned[0]! : "";
}

function propEventType(sentence: string): DerivedPropEvent["eventType"] {
  if (DESTROYED_RE.test(sentence)) return "destroyed";
  if (LOST_RE.test(sentence)) return "lost";
  if (TRANSFER_RE.test(sentence)) return "transferred";
  if (ACQUIRE_RE.test(sentence)) return "acquired";
  if (USE_RE.test(sentence)) return "used";
  return "mentioned";
}

function eventStatus(type: DerivedPropEvent["eventType"]): DerivedPropEvent["status"] {
  if (type === "destroyed") return "destroyed";
  if (type === "lost") return "lost";
  return "active";
}

function deriveProps(args: {
  readonly title: string;
  readonly sentences: readonly string[];
  readonly characters: readonly string[];
  readonly locations: readonly string[];
  readonly knownProps: readonly string[];
}): DerivedPropEvent[] {
  const evidenceByName = new Map<string, string[]>();
  const add = (candidate: string, sentence: string) => {
    let name = propName(candidate, args.characters, args.locations);
    if (!name) return;
    if (GENERIC_PROP_NAMES.has(name)) {
      const aliases = args.knownProps.filter((known) => known !== name && known.endsWith(name));
      if (aliases.length === 1) name = aliases[0]!;
    }
    const rows = evidenceByName.get(name) ?? [];
    if (!rows.includes(sentence)) rows.push(sentence);
    evidenceByName.set(name, rows);
  };
  add(args.title, args.title);
  for (const sentence of args.sentences) {
    for (const known of args.knownProps) if (sentence.includes(known)) add(known, sentence);
    for (const clause of sentence.split(/[，,；;]/u)) {
      if (!DESTROYED_RE.test(clause) && !LOST_RE.test(clause) && !TRANSFER_RE.test(clause) && !ACQUIRE_RE.test(clause) && !USE_RE.test(clause)) continue;
      for (const match of clause.matchAll(PROP_SCAN_RE)) add(match[0], sentence);
    }
  }
  const rows = [...evidenceByName.entries()].map(([name, evidence]) => {
    const sentence = evidence.find((item) => DESTROYED_RE.test(item) || LOST_RE.test(item) || TRANSFER_RE.test(item) || ACQUIRE_RE.test(item) || USE_RE.test(item)) ?? evidence[0] ?? "";
    const clause = sentence.split(/[，,；;]/u).find((item) => item.includes(name))?.trim() || sentence;
    const type = propEventType(clause);
    return {
      name,
      description: compact(clause).slice(0, 500),
      owner: inferOwner(clause, name, args.characters),
      location: args.locations.find((location) => sentence.includes(location)) ?? "",
      status: eventStatus(type),
      eventType: type === "mentioned" && evidence.length === 1 && sentence === args.title ? "introduced" : type,
      evidence: compact(clause).slice(0, 1000),
    };
  });
  return rows.filter((row) => !GENERIC_PROP_NAMES.has(row.name) || !rows.some((candidate) => candidate.name !== row.name && candidate.name.endsWith(row.name))).slice(0, 16);
}

export function deriveNovelContinuityAssets(args: {
  readonly chapterIndex: number;
  readonly title: string;
  readonly content: string;
  readonly eventCards: readonly NovelEventCard[];
  readonly knownCharacters: readonly string[];
  readonly knownLocations: readonly string[];
  readonly knownProps?: readonly string[];
}): DerivedContinuityAssets {
  const sentences = args.content.split(/(?<=[。！？?!])/u).map((part) => compact(part)).filter(Boolean);
  return {
    timeline: args.eventCards.map((card) => ({
      timeLabel: card.evidence.match(TIME_LABEL_RE)?.[0] ?? `第 ${args.chapterIndex} 章`,
      title: card.label.slice(0, 120),
      description: card.evidence.slice(0, 20_000),
      participants: card.actors.slice(0, 100),
    })),
    props: deriveProps({
      title: args.title,
      sentences,
      characters: args.knownCharacters,
      locations: args.knownLocations,
      knownProps: args.knownProps ?? [],
    }),
  };
}

function stateRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function syncNovelContinuityAssetsForChapter(args: {
  readonly store: ContinuityStore;
  readonly projectId: string;
  readonly chapterIndex: number;
  readonly title: string;
  readonly content: string;
  readonly eventCards: readonly NovelEventCard[];
  readonly knownCharacters: readonly string[];
  readonly knownLocations: readonly string[];
}): Promise<{ timelineEvents: number; props: number; propEvents: number }> {
  const currentProps = await args.store.novelProp.findMany({
    where: { projectId: args.projectId },
    select: { id: true, name: true, description: true, owner: true, location: true, status: true, source: true },
  });
  const currentByName = new Map(currentProps.map((item) => [item.name, item]));
  const derived = deriveNovelContinuityAssets({
    chapterIndex: args.chapterIndex,
    title: args.title,
    content: args.content,
    eventCards: args.eventCards,
    knownCharacters: args.knownCharacters,
    knownLocations: args.knownLocations,
    knownProps: currentProps.map((item) => item.name),
  });

  const timelineRows = derived.timeline.map((event) => ({
    event,
    sourceKey: `chapter:${args.chapterIndex}:timeline:${stableHash(`${event.title}\u0000${event.description}`)}`,
  }));
  await args.store.novelTimelineEvent.deleteMany({
    where: {
      projectId: args.projectId,
      chapterNumber: args.chapterIndex,
      source: AUTO_CONTINUITY_SOURCE,
      ...(timelineRows.length ? { sourceKey: { notIn: timelineRows.map((row) => row.sourceKey) } } : {}),
    },
  });
  for (const row of timelineRows) {
    await args.store.novelTimelineEvent.upsert({
      where: { projectId_sourceKey: { projectId: args.projectId, sourceKey: row.sourceKey } },
      create: { projectId: args.projectId, chapterNumber: args.chapterIndex, ...row.event, source: AUTO_CONTINUITY_SOURCE, sourceKey: row.sourceKey },
      update: { chapterNumber: args.chapterIndex, ...row.event, source: AUTO_CONTINUITY_SOURCE },
    });
  }

  const existingAutoEvents = await args.store.novelPropEvent.findMany({
    where: { projectId: args.projectId, chapterNumber: args.chapterIndex, source: AUTO_CONTINUITY_SOURCE },
    select: { propId: true, sourceKey: true },
  });
  const propRows = derived.props.map((event) => ({
    event,
    sourceKey: `chapter:${args.chapterIndex}:prop:${stableHash(event.name)}:${event.eventType}`,
  }));
  await args.store.novelPropEvent.deleteMany({
    where: {
      projectId: args.projectId,
      chapterNumber: args.chapterIndex,
      source: AUTO_CONTINUITY_SOURCE,
      ...(propRows.length ? { sourceKey: { notIn: propRows.map((row) => row.sourceKey) } } : {}),
    },
  });
  const touchedPropIds = new Set(existingAutoEvents.map((event) => event.propId));
  for (const row of propRows) {
    const previous = currentByName.get(row.event.name);
    const owner = row.event.owner || previous?.owner || "";
    const location = row.event.location || previous?.location || "";
    const status = row.event.status === "active" && previous && ["lost", "destroyed", "retired"].includes(previous.status) && row.event.eventType === "mentioned" ? previous.status : row.event.status;
    const prop = await args.store.novelProp.upsert({
      where: { projectId_name: { projectId: args.projectId, name: row.event.name } },
      create: {
        projectId: args.projectId,
        name: row.event.name,
        description: row.event.description,
        owner,
        location,
        status,
        source: AUTO_CONTINUITY_SOURCE,
        metadata: { autoManaged: true },
      },
      update: {
        ...(previous?.description ? {} : { description: row.event.description }),
      },
    });
    touchedPropIds.add(prop.id);
    const stateAfter = { owner, location, status };
    await args.store.novelPropEvent.upsert({
      where: { projectId_sourceKey: { projectId: args.projectId, sourceKey: row.sourceKey } },
      create: {
        projectId: args.projectId,
        propId: prop.id,
        chapterNumber: args.chapterIndex,
        eventType: row.event.eventType,
        description: row.event.evidence,
        stateAfter,
        source: AUTO_CONTINUITY_SOURCE,
        sourceKey: row.sourceKey,
      },
      update: { propId: prop.id, eventType: row.event.eventType, description: row.event.evidence, stateAfter, source: AUTO_CONTINUITY_SOURCE },
    });
  }

  for (const propId of touchedPropIds) {
    const latest = await args.store.novelPropEvent.findFirst({
      where: { projectId: args.projectId, propId },
      orderBy: [{ chapterNumber: "desc" }, { createdAt: "desc" }],
    });
    if (!latest) {
      await args.store.novelProp.deleteMany({ where: { id: propId, projectId: args.projectId, source: AUTO_CONTINUITY_SOURCE } });
      continue;
    }
    const state = stateRecord(latest.stateAfter);
    await args.store.novelProp.update({
      where: { id: propId },
      data: {
        owner: typeof state.owner === "string" ? state.owner : "",
        location: typeof state.location === "string" ? state.location : "",
        status: typeof state.status === "string" ? state.status : "active",
      },
    });
  }
  return { timelineEvents: timelineRows.length, props: derived.props.length, propEvents: propRows.length };
}

export async function backfillNovelContinuityAssets(args: {
  readonly prisma: PrismaClient;
  readonly projectId: string;
}): Promise<{ chapters: number; timelineEvents: number; props: number; propEvents: number }> {
  const [chapters, characters, locations] = await Promise.all([
    args.prisma.novelChapter.findMany({ where: { projectId: args.projectId, content: { not: "" } }, orderBy: { chapterIndex: "asc" }, select: { chapterIndex: true, title: true, content: true } }),
    args.prisma.novelCharacter.findMany({ where: { projectId: args.projectId }, select: { name: true } }),
    args.prisma.novelLocation.findMany({ where: { projectId: args.projectId }, select: { name: true } }),
  ]);
  await args.prisma.$transaction([
    args.prisma.novelTimelineEvent.deleteMany({ where: { projectId: args.projectId, source: AUTO_CONTINUITY_SOURCE } }),
    args.prisma.novelPropEvent.deleteMany({ where: { projectId: args.projectId, source: AUTO_CONTINUITY_SOURCE } }),
    args.prisma.novelProp.deleteMany({ where: { projectId: args.projectId, source: AUTO_CONTINUITY_SOURCE } }),
  ]);
  let timelineEvents = 0;
  let propEvents = 0;
  for (const chapter of chapters) {
    const chapterAssets = deriveNovelChapterAssets({ content: chapter.content, characters: characters.map((item) => item.name), locations: locations.map((item) => item.name) });
    const result = await args.prisma.$transaction((tx) => syncNovelContinuityAssetsForChapter({
      store: tx,
      projectId: args.projectId,
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      content: chapter.content,
      eventCards: chapterAssets.eventCards,
      knownCharacters: characters.map((item) => item.name),
      knownLocations: locations.map((item) => item.name),
    }));
    timelineEvents += result.timelineEvents;
    propEvents += result.propEvents;
  }
  const props = await args.prisma.novelProp.count({ where: { projectId: args.projectId } });
  return { chapters: chapters.length, timelineEvents, props, propEvents };
}
