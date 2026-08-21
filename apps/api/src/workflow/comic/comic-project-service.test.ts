import { describe, expect, it, vi } from "vitest";
import {
  activateComicScriptVersion,
  createComicEpisode,
  createComicProject,
  createComicScriptVersion,
  getComicProjectDetail,
  listComicProjects,
  type ComicProjectStore,
} from "./comic-project-service.js";

function now(): Date {
  return new Date("2026-07-02T06:30:00.000Z");
}

describe("comic project service", () => {
  it("creates and lists user-scoped comic projects", async () => {
    const projects: Array<{
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
    }> = [];

    const store: ComicProjectStore = {
      comicWorkflowProject: {
        create: vi.fn(async (args) => {
          const row = {
            id: `project-${projects.length + 1}`,
            status: "active",
            currentStage: "script",
            settings: {},
            createdAt: now(),
            updatedAt: now(),
            ...args.data,
          };
          projects.push(row);
          return row;
        }),
        findMany: vi.fn(async (args) => projects.filter((project) => project.userId === args.where.userId)),
        findFirst: vi.fn(async () => null),
        update: vi.fn(),
        delete: vi.fn(),
      },
      comicWorkflowBibleEntry: {
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        findFirst: vi.fn(),
      },
      comicWorkflowEpisode: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      comicWorkflowScriptVersion: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback) => callback(store)),
    };

    const created = await createComicProject(store, {
      userId: "user-1",
      title: "霓虹侦探社",
      logline: "失忆侦探追查城市幻影",
      style: "赛博都市",
    });

    expect(created.title).toBe("霓虹侦探社");
    expect(await listComicProjects(store, "user-1")).toHaveLength(1);
    expect(await listComicProjects(store, "user-2")).toHaveLength(0);
  });

  it("returns project detail with ordered episodes, bible entries, and script versions", async () => {
    const store: ComicProjectStore = {
      comicWorkflowProject: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(async () => ({
          id: "project-1",
          userId: "user-1",
          title: "霓虹侦探社",
          logline: "",
          style: "赛博都市",
          status: "active",
          currentStage: "script",
          settings: {},
          createdAt: now(),
          updatedAt: now(),
          bibleEntries: [
            { id: "bible-2", projectId: "project-1", userId: "user-1", category: "scene", title: "旧港区", content: "", position: 2, createdAt: now(), updatedAt: now() },
            { id: "bible-1", projectId: "project-1", userId: "user-1", category: "character", title: "林澈", content: "", position: 1, createdAt: now(), updatedAt: now() },
          ],
          episodes: [
            { id: "episode-2", projectId: "project-1", userId: "user-1", title: "第二集", summary: "", episodeNo: 2, targetDurationSec: 90, currentStage: "script", scriptVersionId: null, createdAt: now(), updatedAt: now(), scriptVersions: [] },
            { id: "episode-1", projectId: "project-1", userId: "user-1", title: "第一集", summary: "", episodeNo: 1, targetDurationSec: 90, currentStage: "script", scriptVersionId: "script-1", createdAt: now(), updatedAt: now(), scriptVersions: [
              { id: "script-1", episodeId: "episode-1", projectId: "project-1", userId: "user-1", versionNo: 1, status: "active", outline: "", scriptText: "开场", source: "manual", prompt: "", metadata: {}, createdAt: now(), updatedAt: now() },
            ] },
          ],
        })),
        update: vi.fn(),
        delete: vi.fn(),
      },
      comicWorkflowBibleEntry: {
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        findFirst: vi.fn(),
      },
      comicWorkflowEpisode: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      comicWorkflowScriptVersion: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback) => callback(store)),
    };

    const detail = await getComicProjectDetail(store, "user-1", "project-1");

    expect(detail?.bibleEntries.map((entry) => entry.id)).toEqual(["bible-1", "bible-2"]);
    expect(detail?.episodes.map((episode) => episode.id)).toEqual(["episode-1", "episode-2"]);
    expect(detail?.episodes[0]?.scriptVersions.map((version) => version.id)).toEqual(["script-1"]);
  });

  it("creates an episode with the next episode number", async () => {
    const store: ComicProjectStore = {
      comicWorkflowProject: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(async () => ({
          id: "project-1",
          userId: "user-1",
          title: "霓虹侦探社",
          logline: "",
          style: "",
          status: "active",
          currentStage: "script",
          settings: {},
          createdAt: now(),
          updatedAt: now(),
        })),
        update: vi.fn(),
        delete: vi.fn(),
      },
      comicWorkflowBibleEntry: {
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        findFirst: vi.fn(),
      },
      comicWorkflowEpisode: {
        create: vi.fn(async (args) => ({ id: "episode-3", currentStage: "script", scriptVersionId: null, createdAt: now(), updatedAt: now(), ...args.data })),
        findMany: vi.fn(),
        findFirst: vi.fn(async () => ({ episodeNo: 2 })),
        update: vi.fn(),
      },
      comicWorkflowScriptVersion: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback) => callback(store)),
    };

    const episode = await createComicEpisode(store, {
      userId: "user-1",
      projectId: "project-1",
      title: "第三集",
      summary: "",
      targetDurationSec: 80,
    });

    if (!episode) throw new Error("episode should be created");
    expect(episode.episodeNo).toBe(3);
  });

  it("creates and activates script versions within the owned episode", async () => {
    const updates: string[] = [];
    let createdVersion: {
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
    } | null = null;
    const store: ComicProjectStore = {
      comicWorkflowProject: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      comicWorkflowBibleEntry: {
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        findFirst: vi.fn(),
      },
      comicWorkflowEpisode: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(async () => ({
          id: "episode-1",
          projectId: "project-1",
          userId: "user-1",
          title: "第一集",
          summary: "",
          episodeNo: 1,
          targetDurationSec: 90,
          currentStage: "script",
          scriptVersionId: null,
          createdAt: now(),
          updatedAt: now(),
        })),
        update: vi.fn(async (args) => {
          updates.push(`episode:${args.where.id}:${args.data.scriptVersionId ?? ""}`);
          return {
            id: args.where.id,
            projectId: "project-1",
            userId: "user-1",
            title: "第一集",
            summary: "",
            episodeNo: 1,
            targetDurationSec: 90,
            currentStage: "assets",
            scriptVersionId: args.data.scriptVersionId ?? null,
            createdAt: now(),
            updatedAt: now(),
          };
        }),
      },
      comicWorkflowScriptVersion: {
        create: vi.fn(async (args) => {
          const row = { id: "script-1", createdAt: now(), updatedAt: now(), metadata: {}, ...args.data };
          createdVersion = row;
          return row;
        }),
        findMany: vi.fn(),
        findFirst: vi.fn(async (args) => {
          if (!createdVersion || args.where.id !== createdVersion.id) return null;
          return createdVersion;
        }),
        update: vi.fn(async (args) => {
          updates.push(`script:${args.where.id}:${args.data.status}`);
          return {
            id: args.where.id,
            episodeId: "episode-1",
            projectId: "project-1",
            userId: "user-1",
            versionNo: 1,
            status: args.data.status ?? "active",
            outline: "",
            scriptText: "开场",
            source: "manual",
            prompt: "",
            metadata: {},
            createdAt: now(),
            updatedAt: now(),
          };
        }),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $transaction: vi.fn(async (callback) => callback(store)),
    };

    const version = await createComicScriptVersion(store, {
      userId: "user-1",
      episodeId: "episode-1",
      outline: "委托",
      scriptText: "开场",
      source: "manual",
      prompt: "",
    });
    if (!version) throw new Error("script version should be created");
    const active = await activateComicScriptVersion(store, "user-1", version.id);

    expect(version.versionNo).toBe(1);
    expect(active?.status).toBe("active");
    expect(updates).toContain("episode:episode-1:script-1");
  });
});
