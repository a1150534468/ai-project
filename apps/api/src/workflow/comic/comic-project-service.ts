import type { ComicScriptSource, ComicStage } from "./comic-types.js";
import {
  comicProjectStoreFromPrisma,
  type ComicBibleEntryRow,
  type ComicEpisodeDetailRow,
  type ComicEpisodeRow,
  type ComicProjectDetailRow,
  type ComicProjectRow,
  type ComicProjectStore,
  type ComicScriptVersionRow,
  type CreateBibleEntryData,
  type CreateEpisodeData,
  type CreateProjectData,
} from "./comic-project-store.js";

export { comicProjectStoreFromPrisma };
export type { ComicProjectStore } from "./comic-project-store.js";

function sortBibleEntries(entries: readonly ComicBibleEntryRow[]): readonly ComicBibleEntryRow[] {
  return [...entries].sort((left, right) => left.position - right.position);
}

function sortEpisodes(episodes: readonly ComicEpisodeDetailRow[]): readonly ComicEpisodeDetailRow[] {
  return [...episodes].sort((left, right) => left.episodeNo - right.episodeNo);
}

function sortScriptVersions(versions: readonly ComicScriptVersionRow[]): readonly ComicScriptVersionRow[] {
  return [...versions].sort((left, right) => left.versionNo - right.versionNo);
}

function hasProjectDetail(row: ComicProjectRow | ComicProjectDetailRow): row is ComicProjectDetailRow {
  return "bibleEntries" in row && "episodes" in row;
}

function toProjectSummary(row: ComicProjectRow) {
  return {
    id: row.id,
    title: row.title,
    logline: row.logline,
    style: row.style,
    status: row.status,
    currentStage: row.currentStage,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toScriptVersion(row: ComicScriptVersionRow) {
  return {
    id: row.id,
    versionNo: row.versionNo,
    status: row.status,
    outline: row.outline,
    scriptText: row.scriptText,
    source: row.source,
    prompt: row.prompt,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEpisode(row: ComicEpisodeDetailRow) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    episodeNo: row.episodeNo,
    targetDurationSec: row.targetDurationSec,
    currentStage: row.currentStage,
    scriptVersionId: row.scriptVersionId,
    updatedAt: row.updatedAt.toISOString(),
    scriptVersions: sortScriptVersions(row.scriptVersions).map(toScriptVersion),
  };
}

function toBibleEntry(row: ComicBibleEntryRow) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    position: row.position,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEpisodeSummary(row: ComicEpisodeRow) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    episodeNo: row.episodeNo,
    targetDurationSec: row.targetDurationSec,
    currentStage: row.currentStage,
    scriptVersionId: row.scriptVersionId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listComicProjects(store: ComicProjectStore, userId: string) {
  const rows = await store.comicWorkflowProject.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 30,
  });
  return rows.map(toProjectSummary);
}

export async function createComicProject(store: ComicProjectStore, input: CreateProjectData) {
  const row = await store.comicWorkflowProject.create({ data: input });
  return toProjectSummary(row);
}

export async function findOwnedComicProject(store: ComicProjectStore, userId: string, projectId: string): Promise<ComicProjectRow | null> {
  return store.comicWorkflowProject.findFirst({ where: { id: projectId, userId } });
}

export async function getComicProjectDetail(store: ComicProjectStore, userId: string, projectId: string) {
  const row = await store.comicWorkflowProject.findFirst({
    where: { id: projectId, userId },
    include: {
      bibleEntries: { orderBy: { position: "asc" } },
      episodes: {
        orderBy: { episodeNo: "asc" },
        include: { scriptVersions: { orderBy: { versionNo: "desc" } } },
      },
    },
  });
  if (!row) return null;
  const detail = hasProjectDetail(row) ? row : { ...row, bibleEntries: [], episodes: [] };
  return {
    ...toProjectSummary(detail),
    bibleEntries: sortBibleEntries(detail.bibleEntries).map(toBibleEntry),
    episodes: sortEpisodes(detail.episodes).map(toEpisode),
  };
}

export async function updateComicProject(
  store: ComicProjectStore,
  userId: string,
  projectId: string,
  data: Partial<Pick<CreateProjectData, "title" | "logline" | "style">>,
) {
  const project = await findOwnedComicProject(store, userId, projectId);
  if (!project) return null;
  await store.comicWorkflowProject.update({ where: { id: project.id }, data });
  return getComicProjectDetail(store, userId, project.id);
}

export async function deleteComicProject(store: ComicProjectStore, userId: string, projectId: string): Promise<boolean> {
  const project = await findOwnedComicProject(store, userId, projectId);
  if (!project) return false;
  await store.comicWorkflowProject.delete({ where: { id: project.id } });
  return true;
}

export async function listComicBibleEntries(store: ComicProjectStore, userId: string, projectId: string) {
  const project = await findOwnedComicProject(store, userId, projectId);
  if (!project) return null;
  const rows = await store.comicWorkflowBibleEntry.findMany({
    where: { projectId: project.id, userId },
    orderBy: { position: "asc" },
  });
  return sortBibleEntries(rows).map(toBibleEntry);
}

export async function createComicBibleEntry(store: ComicProjectStore, input: CreateBibleEntryData) {
  const project = await findOwnedComicProject(store, input.userId, input.projectId);
  if (!project) return null;
  return toBibleEntry(await store.comicWorkflowBibleEntry.create({ data: input }));
}

export async function updateComicBibleEntry(
  store: ComicProjectStore,
  userId: string,
  entryId: string,
  data: Partial<Pick<CreateBibleEntryData, "category" | "title" | "content" | "position">>,
) {
  const entry = await store.comicWorkflowBibleEntry.findFirst({ where: { id: entryId, userId } });
  if (!entry) return null;
  return toBibleEntry(await store.comicWorkflowBibleEntry.update({ where: { id: entry.id }, data }));
}

export async function deleteComicBibleEntry(store: ComicProjectStore, userId: string, entryId: string): Promise<boolean> {
  const entry = await store.comicWorkflowBibleEntry.findFirst({ where: { id: entryId, userId } });
  if (!entry) return false;
  await store.comicWorkflowBibleEntry.delete({ where: { id: entry.id } });
  return true;
}

export async function listComicEpisodes(store: ComicProjectStore, userId: string, projectId: string) {
  const project = await findOwnedComicProject(store, userId, projectId);
  if (!project) return null;
  const rows = await store.comicWorkflowEpisode.findMany({
    where: { projectId: project.id, userId },
    orderBy: { episodeNo: "asc" },
  });
  return [...rows].sort((left, right) => left.episodeNo - right.episodeNo).map(toEpisodeSummary);
}

export async function createComicEpisode(store: ComicProjectStore, input: Omit<CreateEpisodeData, "episodeNo">) {
  const project = await findOwnedComicProject(store, input.userId, input.projectId);
  if (!project) return null;
  const latest = await store.comicWorkflowEpisode.findFirst({
    where: { projectId: input.projectId, userId: input.userId },
    orderBy: { episodeNo: "desc" },
  });
  const episodeNo = latest ? latest.episodeNo + 1 : 1;
  return toEpisodeSummary(await store.comicWorkflowEpisode.create({ data: { ...input, episodeNo } }));
}

export async function updateComicEpisode(
  store: ComicProjectStore,
  userId: string,
  episodeId: string,
  data: Partial<Pick<CreateEpisodeData, "title" | "summary" | "targetDurationSec">>,
) {
  const episode = await store.comicWorkflowEpisode.findFirst({ where: { id: episodeId, userId } });
  if (!episode || !("id" in episode)) return null;
  return toEpisodeSummary(await store.comicWorkflowEpisode.update({ where: { id: episode.id }, data }));
}

export async function createComicScriptVersion(
  store: ComicProjectStore,
  input: {
    readonly userId: string;
    readonly episodeId: string;
    readonly outline: string;
    readonly scriptText: string;
    readonly source: ComicScriptSource;
    readonly prompt: string;
  },
) {
  const episode = await store.comicWorkflowEpisode.findFirst({ where: { id: input.episodeId, userId: input.userId } });
  if (!episode || !("projectId" in episode)) return null;
  const latest = await store.comicWorkflowScriptVersion.findFirst({
    where: { episodeId: input.episodeId, userId: input.userId },
    orderBy: { versionNo: "desc" },
  });
  const versionNo = latest ? latest.versionNo + 1 : 1;
  return store.comicWorkflowScriptVersion.create({
    data: {
      episodeId: episode.id,
      projectId: episode.projectId,
      userId: input.userId,
      versionNo,
      status: "draft",
      outline: input.outline,
      scriptText: input.scriptText,
      source: input.source,
      prompt: input.prompt,
    },
  });
}

export async function listComicScriptVersions(store: ComicProjectStore, userId: string, episodeId: string) {
  const episode = await store.comicWorkflowEpisode.findFirst({ where: { id: episodeId, userId } });
  if (!episode) return null;
  const rows = await store.comicWorkflowScriptVersion.findMany({
    where: { episodeId, userId },
    orderBy: { versionNo: "desc" },
  });
  return sortScriptVersions(rows).map(toScriptVersion);
}

export async function activateComicScriptVersion(store: ComicProjectStore, userId: string, versionId: string) {
  return store.$transaction(async (tx) => {
    const version = await tx.comicWorkflowScriptVersion.findFirst({ where: { id: versionId, userId } });
    if (!version) return null;
    await tx.comicWorkflowScriptVersion.updateMany({
      where: { episodeId: version.episodeId, userId },
      data: { status: "draft" },
    });
    const active = await tx.comicWorkflowScriptVersion.update({
      where: { id: version.id },
      data: { status: "active" },
    });
    await tx.comicWorkflowEpisode.update({
      where: { id: version.episodeId },
      data: { scriptVersionId: version.id, currentStage: "assets" satisfies ComicStage },
    });
    return active;
  });
}
