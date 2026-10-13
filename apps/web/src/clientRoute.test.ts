import { describe, expect, it } from "vitest";
import { hashForRoute, routeFromHash } from "./clientRoute";

describe("client route", () => {
  it("编码主视图与工作流模块", () => {
    expect(hashForRoute({ view: "chat", workflowModule: "image" })).toBe("#chat");
    expect(hashForRoute({ view: "settings", workflowModule: "image" })).toBe("#settings");
    expect(hashForRoute({ view: "workflow", workflowModule: "novel" })).toBe("#workflow/novel");
    expect(hashForRoute({ view: "workflow", workflowModule: "image" })).toBe("#workflow/image");
  });

  it("解码主视图", () => {
    expect(routeFromHash("#kb")).toEqual({ view: "kb", workflowModule: "image" });
    expect(routeFromHash("#memory")).toEqual({ view: "memory", workflowModule: "image" });
  });

  it("解码工作流模块，认不出的模块回落到生图", () => {
    expect(routeFromHash("#workflow/codex-pet")).toEqual({ view: "workflow", workflowModule: "codex-pet" });
    expect(routeFromHash("#workflow/bogus")).toEqual({ view: "workflow", workflowModule: "image" });
    expect(routeFromHash("#workflow")).toEqual({ view: "workflow", workflowModule: "image" });
  });

  it("小说工作台深链归到工作流/小说", () => {
    expect(routeFromHash("#novel/project-1/workbench")).toEqual({ view: "workflow", workflowModule: "novel" });
  });

  it("空 hash 或认不出的 hash 返回 null", () => {
    expect(routeFromHash("")).toBeNull();
    expect(routeFromHash("#")).toBeNull();
    expect(routeFromHash("#nope")).toBeNull();
  });

  it("编解码往返一致", () => {
    for (const route of [
      { view: "chat", workflowModule: "image" },
      { view: "assets", workflowModule: "image" },
      { view: "workflow", workflowModule: "article-workflow" },
    ] as const) {
      expect(routeFromHash(hashForRoute(route))).toEqual(route);
    }
  });
});
