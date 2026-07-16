import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { buildNovelChapterPostprocessPayload } from "../workflow/novel-postprocess.js";
import type { NovelForeshadowPayload } from "../workflow/novel-workbench-types.js";

export const AUTO_LEDGER_SOURCE = "chapterPostprocess";
const RESOLUTION_CUE_RE = /(原来|答案|真相|谜底|揭晓|证实|确认了|终于明白|终于知道|身份是|目的就是|因为这|正是|其实是)/u;
const UNRESOLVED_CUE_RE = /(没有答案|仍(?:然)?没有|尚未|依旧不知|还不知道|不清楚|仍是谜|无法确认|未能确认)/u;
const IGNORED_CHARS = new Set(Array.from("你我他她它的是了吗呢啊吧着了在和与及就这那一个为何为什么究竟怎么如何什么谁“”‘’？！？，。；：、\n \t"));

type LedgerStore = Pick<Prisma.TransactionClient, "novelForeshadowItem" | "novelForeshadowEvent" | "novelNarrativeDebt">;

function stableHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function sentences(content: string): string[] {
  return content.split(/(?<=[。！？?!])/u).map((value) => value.replace(/\s+/gu, " ").trim()).filter(Boolean);
}

function meaningfulChars(value: string): Set<string> {
  return new Set(Array.from(value).filter((char) => !IGNORED_CHARS.has(char) && /[\p{Script=Han}A-Za-z0-9]/u.test(char)));
}

function meaningfulText(value: string): string {
  return Array.from(value).filter((char) => !IGNORED_CHARS.has(char) && /[\p{Script=Han}A-Za-z0-9]/u.test(char)).join("");
}

function trigrams(value: string): string[] {
  const chars = Array.from(value);
  return chars.flatMap((_, index) => index + 3 <= chars.length ? [chars.slice(index, index + 3).join("")] : []);
}

export function findLedgerEvidence(title: string, content: string): { evidence: string; confidence: number; resolved: boolean } | null {
  const target = meaningfulChars(title);
  const targetPhrases = trigrams(meaningfulText(title));
  if (target.size < 3) return null;
  let best: { evidence: string; confidence: number; resolved: boolean } | null = null;
  const rows = sentences(content);
  rows.forEach((row, index) => {
    const candidate = meaningfulChars(row);
    const compactCandidate = meaningfulText(row);
    const overlap = [...target].filter((char) => candidate.has(char)).length;
    const confidence = overlap / Math.min(Math.max(target.size, 1), 14);
    const phraseMatch = targetPhrases.some((phrase) => compactCandidate.includes(phrase));
    if (overlap < 3 || confidence < 0.42 || (!phraseMatch && confidence < 0.65)) return;
    const window = `${rows[Math.max(0, index - 1)] ?? ""}${row}${rows[index + 1] ?? ""}`.slice(0, 600);
    const result = { evidence: row.slice(0, 500), confidence: Math.min(0.96, Number((confidence + (phraseMatch ? 0.08 : 0)).toFixed(2))), resolved: RESOLUTION_CUE_RE.test(row) && !UNRESOLVED_CUE_RE.test(window) };
    if (!best || result.confidence > best.confidence || (result.resolved && !best.resolved)) best = result;
  });
  return best;
}

export async function syncNovelNarrativeLedgersForChapter(args: {
  readonly store: LedgerStore;
  readonly projectId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly content: string;
  readonly foreshadowItems: readonly NovelForeshadowPayload[];
}): Promise<{ planted: number; reinforced: number; resolved: number; debts: number }> {
  const { store, projectId, chapterId, chapterIndex } = args;
  const autoIntroduced = await store.novelForeshadowItem.findMany({
    where: { projectId, introducedInChapterIndex: chapterIndex, source: { in: [AUTO_LEDGER_SOURCE, "legacyAuto"] } },
    select: { id: true },
  });
  if (autoIntroduced.length) await store.novelForeshadowItem.deleteMany({ where: { id: { in: autoIntroduced.map((item) => item.id) } } });
  await store.novelForeshadowEvent.deleteMany({ where: { projectId, chapterIndex, source: AUTO_LEDGER_SOURCE } });
  await store.novelNarrativeDebt.deleteMany({ where: { projectId, introducedChapter: chapterIndex, source: { in: [AUTO_LEDGER_SOURCE, "legacyAuto"] } } });

  const active = await store.novelForeshadowItem.findMany({
    where: {
      projectId,
      status: { in: ["open", "hinted"] },
      OR: [{ introducedInChapterIndex: null }, { introducedInChapterIndex: { lt: chapterIndex } }],
    },
  });
  let reinforced = 0;
  let resolved = 0;
  for (const item of active) {
    const match = findLedgerEvidence(`${item.title} ${item.description}`, args.content);
    if (!match) continue;
    const action = match.resolved ? "paidOff" : "reinforced";
    const sourceKey = `chapter:${chapterIndex}:foreshadow:${item.id}:${action}`;
    await store.novelForeshadowEvent.upsert({
      where: { projectId_sourceKey: { projectId, sourceKey } },
      create: { projectId, foreshadowId: item.id, chapterId, chapterIndex, action, evidence: match.evidence, confidence: match.confidence, source: AUTO_LEDGER_SOURCE, sourceKey },
      update: { evidence: match.evidence, confidence: match.confidence },
    });
    await store.novelForeshadowItem.update({
      where: { id: item.id },
      data: match.resolved
        ? { status: "resolved", lastMentionedChapter: chapterIndex, resolvedInChapterIndex: chapterIndex, resolutionEvidence: match.evidence }
        : { status: "hinted", lastMentionedChapter: chapterIndex },
    });
    if (match.resolved) {
      resolved += 1;
      await store.novelNarrativeDebt.updateMany({ where: { projectId, foreshadowId: item.id, status: "open" }, data: { status: "resolved", resolvedInChapter: chapterIndex, resolutionEvidence: match.evidence } });
    } else reinforced += 1;
  }

  let planted = 0;
  let debts = 0;
  for (const input of args.foreshadowItems) {
    const title = input.title.trim().slice(0, 120);
    if (!title) continue;
    const itemSourceKey = `chapter:${chapterIndex}:foreshadow:${stableHash(title)}`;
    const existing = await store.novelForeshadowItem.findUnique({ where: { projectId_title: { projectId, title } } });
    const item = existing ?? await store.novelForeshadowItem.create({
      data: {
        projectId,
        introducedInChapterId: chapterId,
        introducedInChapterIndex: chapterIndex,
        title,
        description: input.description,
        expectedPayoffChapter: input.expectedPayoffChapter,
        status: "open",
        relatedCharacter: input.relatedCharacter,
        source: AUTO_LEDGER_SOURCE,
        sourceKey: itemSourceKey,
        lastMentionedChapter: chapterIndex,
      },
    });
    if (!existing) planted += 1;
    const eventSourceKey = `${itemSourceKey}:planted`;
    await store.novelForeshadowEvent.upsert({
      where: { projectId_sourceKey: { projectId, sourceKey: eventSourceKey } },
      create: { projectId, foreshadowId: item.id, chapterId, chapterIndex, action: "planted", evidence: input.description, confidence: 0.82, source: AUTO_LEDGER_SOURCE, sourceKey: eventSourceKey },
      update: { evidence: input.description },
    });
    if (["open", "hinted"].includes(item.status)) {
      const debtSourceKey = `chapter:${chapterIndex}:debt:${stableHash(title)}`;
      await store.novelNarrativeDebt.upsert({
        where: { projectId_sourceKey: { projectId, sourceKey: debtSourceKey } },
        create: { projectId, debtType: "openThread", title, description: input.description, introducedChapter: chapterIndex, dueChapter: input.expectedPayoffChapter, status: "open", severity: "medium", foreshadowId: item.id, source: AUTO_LEDGER_SOURCE, sourceKey: debtSourceKey },
        update: { description: input.description, dueChapter: input.expectedPayoffChapter, foreshadowId: item.id },
      });
      debts += 1;
    }
  }
  return { planted, reinforced, resolved, debts };
}

export async function backfillNovelNarrativeLedgers(args: { readonly prisma: PrismaClient; readonly projectId: string }): Promise<{ chapters: number; foreshadows: number; foreshadowEvents: number; debts: number; reinforced: number; resolved: number }> {
  const [chapters, characters, locations] = await Promise.all([
    args.prisma.novelChapter.findMany({ where: { projectId: args.projectId, content: { not: "" } }, orderBy: { chapterIndex: "asc" }, select: { id: true, chapterIndex: true, title: true, content: true } }),
    args.prisma.novelCharacter.findMany({ where: { projectId: args.projectId }, select: { name: true } }),
    args.prisma.novelLocation.findMany({ where: { projectId: args.projectId }, select: { name: true } }),
  ]);
  await args.prisma.$transaction([
    args.prisma.novelForeshadowItem.deleteMany({ where: { projectId: args.projectId, source: { in: [AUTO_LEDGER_SOURCE, "legacyAuto"] } } }),
    args.prisma.novelNarrativeDebt.deleteMany({ where: { projectId: args.projectId, source: { in: [AUTO_LEDGER_SOURCE, "legacyAuto"] } } }),
    args.prisma.novelForeshadowEvent.deleteMany({ where: { projectId: args.projectId, source: AUTO_LEDGER_SOURCE } }),
  ]);
  let reinforced = 0;
  let resolved = 0;
  for (const chapter of chapters) {
    const postprocess = buildNovelChapterPostprocessPayload({
      projectTitle: "",
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      content: chapter.content,
      knownCharacters: characters.map((item) => item.name),
      knownLocations: locations.map((item) => item.name),
    });
    const result = await args.prisma.$transaction((tx) => syncNovelNarrativeLedgersForChapter({
      store: tx,
      projectId: args.projectId,
      chapterId: chapter.id,
      chapterIndex: chapter.chapterIndex,
      content: chapter.content,
      foreshadowItems: postprocess.foreshadowItems,
    }));
    reinforced += result.reinforced;
    resolved += result.resolved;
  }
  const [foreshadows, foreshadowEvents, debts] = await Promise.all([
    args.prisma.novelForeshadowItem.count({ where: { projectId: args.projectId } }),
    args.prisma.novelForeshadowEvent.count({ where: { projectId: args.projectId } }),
    args.prisma.novelNarrativeDebt.count({ where: { projectId: args.projectId } }),
  ]);
  return { chapters: chapters.length, foreshadows, foreshadowEvents, debts, reinforced, resolved };
}
