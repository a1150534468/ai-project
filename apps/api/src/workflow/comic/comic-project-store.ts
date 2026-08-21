import type { Prisma, PrismaClient } from "@prisma/client";
import type { ComicScriptSource } from "./comic-types.js";

type SortDirection = "asc" | "desc";

export interface ComicProjectRow {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly logline: string;
  readonly style: string;
  readonly status: string;
  readonly currentStage: string;
  readonly settings: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ComicBibleEntryRow {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly category: string;
  readonly title: string;
  readonly content: string;
  readonly position: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ComicEpisodeRow {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly title: string;
  readonly summary: string;
  readonly episodeNo: number;
  readonly targetDurationSec: number;
  readonly currentStage: string;
  readonly scriptVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ComicScriptVersionRow {
  readonly id: string;
  readonly episodeId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly versionNo: number;
  readonly status: string;
  readonly outline: string;
  readonly scriptText: string;
  readonly source: string;
  readonly prompt: string;
  readonly metadata: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ComicEpisodeDetailRow = ComicEpisodeRow & {
  readonly scriptVersions: readonly ComicScriptVersionRow[];
};

export type ComicProjectDetailRow = ComicProjectRow & {
  readonly bibleEntries: readonly ComicBibleEntryRow[];
  readonly episodes: readonly ComicEpisodeDetailRow[];
};

export interface CreateProjectData {
  readonly userId: string;
  readonly title: string;
  readonly logline: string;
  readonly style: string;
}

export interface CreateBibleEntryData {
  readonly projectId: string;
  readonly userId: string;
  readonly category: string;
  readonly title: string;
  readonly content: string;
  readonly position: number;
}

export interface CreateEpisodeData {
  readonly projectId: string;
  readonly userId: string;
  readonly title: string;
  readonly summary: string;
  readonly episodeNo: number;
  readonly targetDurationSec: number;
}

export interface CreateScriptVersionData {
  readonly episodeId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly versionNo: number;
  readonly status: string;
  readonly outline: string;
  readonly scriptText: string;
  readonly source: ComicScriptSource;
  readonly prompt: string;
}

interface ProjectDetailInclude {
  readonly bibleEntries?: { readonly orderBy?: { readonly position: SortDirection } };
  readonly episodes?: {
    readonly orderBy?: { readonly episodeNo: SortDirection };
    readonly include?: { readonly scriptVersions?: { readonly orderBy?: { readonly versionNo: SortDirection } } };
  };
}

export interface ComicProjectStore {
  readonly comicWorkflowProject: {
    readonly create: (args: { readonly data: CreateProjectData }) => Promise<ComicProjectRow>;
    readonly findMany: (args: { readonly where: { readonly userId: string }; readonly orderBy?: { readonly updatedAt: SortDirection }; readonly take?: number }) => Promise<readonly ComicProjectRow[]>;
    readonly findFirst: (args: { readonly where: { readonly id?: string; readonly userId?: string }; readonly include?: ProjectDetailInclude }) => Promise<ComicProjectRow | ComicProjectDetailRow | null>;
    readonly update: (args: { readonly where: { readonly id: string }; readonly data: Partial<Pick<ComicProjectRow, "title" | "logline" | "style" | "status" | "currentStage">> }) => Promise<ComicProjectRow>;
    readonly delete: (args: { readonly where: { readonly id: string } }) => Promise<ComicProjectRow>;
  };
  readonly comicWorkflowBibleEntry: {
    readonly findMany: (args: { readonly where: { readonly projectId: string; readonly userId?: string }; readonly orderBy?: { readonly position: SortDirection } }) => Promise<readonly ComicBibleEntryRow[]>;
    readonly create: (args: { readonly data: CreateBibleEntryData }) => Promise<ComicBibleEntryRow>;
    readonly findFirst: (args: { readonly where: { readonly id?: string; readonly userId?: string } }) => Promise<ComicBibleEntryRow | null>;
    readonly update: (args: { readonly where: { readonly id: string }; readonly data: Partial<Pick<ComicBibleEntryRow, "category" | "title" | "content" | "position">> }) => Promise<ComicBibleEntryRow>;
    readonly delete: (args: { readonly where: { readonly id: string } }) => Promise<ComicBibleEntryRow>;
  };
  readonly comicWorkflowEpisode: {
    readonly create: (args: { readonly data: CreateEpisodeData }) => Promise<ComicEpisodeRow>;
    readonly findMany: (args: { readonly where: { readonly projectId: string; readonly userId?: string }; readonly orderBy?: { readonly episodeNo: SortDirection } }) => Promise<readonly ComicEpisodeRow[]>;
    readonly findFirst: (args: { readonly where: { readonly id?: string; readonly userId?: string; readonly projectId?: string }; readonly orderBy?: { readonly episodeNo: SortDirection } }) => Promise<ComicEpisodeRow | Pick<ComicEpisodeRow, "episodeNo"> | null>;
    readonly update: (args: { readonly where: { readonly id: string }; readonly data: Partial<Pick<ComicEpisodeRow, "title" | "summary" | "targetDurationSec" | "currentStage" | "scriptVersionId">> }) => Promise<ComicEpisodeRow>;
  };
  readonly comicWorkflowScriptVersion: {
    readonly create: (args: { readonly data: CreateScriptVersionData }) => Promise<ComicScriptVersionRow>;
    readonly findMany: (args: { readonly where: { readonly episodeId: string; readonly userId?: string }; readonly orderBy?: { readonly versionNo: SortDirection } }) => Promise<readonly ComicScriptVersionRow[]>;
    readonly findFirst: (args: { readonly where: { readonly id?: string; readonly episodeId?: string; readonly userId?: string }; readonly orderBy?: { readonly versionNo: SortDirection } }) => Promise<ComicScriptVersionRow | null>;
    readonly update: (args: { readonly where: { readonly id: string }; readonly data: Partial<Pick<ComicScriptVersionRow, "status" | "outline" | "scriptText" | "prompt">> }) => Promise<ComicScriptVersionRow>;
    readonly updateMany: (args: { readonly where: { readonly episodeId: string; readonly userId?: string }; readonly data: Partial<Pick<ComicScriptVersionRow, "status">> }) => Promise<{ readonly count: number }>;
  };
  readonly $transaction: <T>(callback: (tx: ComicProjectStore) => Promise<T>) => Promise<T>;
}

type PrismaComicClient = Pick<
  PrismaClient | Prisma.TransactionClient,
  "comicWorkflowProject" | "comicWorkflowBibleEntry" | "comicWorkflowEpisode" | "comicWorkflowScriptVersion"
>;

type RunPrismaTransaction = <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

function prismaStore(prisma: PrismaComicClient, runTransaction?: RunPrismaTransaction): ComicProjectStore {
  const store: ComicProjectStore = {
    comicWorkflowProject: {
      create: (args) => prisma.comicWorkflowProject.create({ data: args.data }),
      findMany: (args) => prisma.comicWorkflowProject.findMany(args),
      findFirst: (args) => prisma.comicWorkflowProject.findFirst(args),
      update: (args) => prisma.comicWorkflowProject.update(args),
      delete: (args) => prisma.comicWorkflowProject.delete(args),
    },
    comicWorkflowBibleEntry: {
      findMany: (args) => prisma.comicWorkflowBibleEntry.findMany(args),
      create: (args) => prisma.comicWorkflowBibleEntry.create({ data: args.data }),
      findFirst: (args) => prisma.comicWorkflowBibleEntry.findFirst(args),
      update: (args) => prisma.comicWorkflowBibleEntry.update(args),
      delete: (args) => prisma.comicWorkflowBibleEntry.delete(args),
    },
    comicWorkflowEpisode: {
      create: (args) => prisma.comicWorkflowEpisode.create({ data: args.data }),
      findMany: (args) => prisma.comicWorkflowEpisode.findMany(args),
      findFirst: (args) => prisma.comicWorkflowEpisode.findFirst(args),
      update: (args) => prisma.comicWorkflowEpisode.update(args),
    },
    comicWorkflowScriptVersion: {
      create: (args) => prisma.comicWorkflowScriptVersion.create({ data: args.data }),
      findMany: (args) => prisma.comicWorkflowScriptVersion.findMany(args),
      findFirst: (args) => prisma.comicWorkflowScriptVersion.findFirst(args),
      update: (args) => prisma.comicWorkflowScriptVersion.update(args),
      updateMany: (args) => prisma.comicWorkflowScriptVersion.updateMany(args),
    },
    $transaction: async (callback) => {
      if (!runTransaction) return callback(store);
      return runTransaction((tx) => callback(prismaStore(tx)));
    },
  };
  return store;
}

export function comicProjectStoreFromPrisma(prisma: PrismaClient): ComicProjectStore {
  return prismaStore(prisma, (callback) => prisma.$transaction(callback));
}
