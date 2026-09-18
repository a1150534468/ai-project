/**
 * 素材库前端纯逻辑的护栏。三组断言，各自钉一件「错了在 UI 上看不出来」的事：
 *  - 筛选项表：与服务端准入规则手工同步，所以这里要求它**自洽且完备**（每个 module 有中文名、
 *    每个分区的筛选项都真属于该分区），并显式钉住 comic 不出现、audio 两区都出现；
 *  - `appendAssetPage`：同源游标是 `lte`，下一页必然带回已给过的兄弟素材，去重不做就会看到重复卡片；
 *  - 两个 formatter：服务端会给 null，文案里不能出现「null」。
 */
import { describe, expect, it } from "vitest";
import { ASSET_SOURCE_MODULES, type AssetItem, type AssetPage } from "./assetApi";
import {
  appendAssetPage,
  ASSET_MODULE_LABELS,
  ASSET_ORIGIN_TABS,
  EMPTY_ASSET_LIST,
  formatAssetDuration,
  formatAssetSize,
  moduleFiltersForOrigin,
} from "./assetLibrary";

function item(id: string): AssetItem {
  return {
    id,
    sourceModule: "image",
    origin: "ai",
    mediaType: "image",
    title: id,
    url: null,
    thumbnailUrl: null,
    mime: "image/png",
    width: null,
    height: null,
    sizeBytes: null,
    durationSec: null,
    createdAt: "2026-08-31T10:00:00.000Z",
    groupKey: null,
    groupLabel: null,
  };
}

const page = (ids: readonly string[], nextCursor: string | null): AssetPage => ({
  items: ids.map(item),
  nextCursor,
});

describe("分区与筛选项", () => {
  it("两个分区各一次，顺序是「AI 生成」在前", () => {
    expect(ASSET_ORIGIN_TABS.map((tab) => tab.origin)).toEqual(["ai", "upload"]);
    expect(ASSET_ORIGIN_TABS.every((tab) => tab.label.length > 0 && tab.emptyText.length > 0)).toBe(true);
  });

  it("每个 module 都有中文名（新增 module 忘了配文案会红）", () => {
    for (const module of ASSET_SOURCE_MODULES) {
      expect(ASSET_MODULE_LABELS[module]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("AI 生成区：含形象照、万物试穿和全部已保留的素材源", () => {
    expect(moduleFiltersForOrigin("ai")).toEqual([
      "image",
      "portrait",
      "try-on",
      "article",
      "ecom",
      "video",
      "audio",
      "codex-pet",
    ]);
  });

  it("我上传的区：只有参考图和音频（背景音乐 / 音色样本）", () => {
    expect(moduleFiltersForOrigin("upload")).toEqual(["reference", "audio"]);
  });

  it("comic 两个分区都不给：漫画分镜整段不收进素材库", () => {
    expect(moduleFiltersForOrigin("ai")).not.toContain("comic");
    expect(moduleFiltersForOrigin("upload")).not.toContain("comic");
  });

  it("筛选项都是合法 module，且同一区内不重复", () => {
    for (const origin of ["ai", "upload"] as const) {
      const modules = moduleFiltersForOrigin(origin);
      expect(new Set(modules).size).toBe(modules.length);
      for (const module of modules) expect(ASSET_SOURCE_MODULES).toContain(module);
    }
  });
});

describe("appendAssetPage", () => {
  it("第一页直接落地，游标带上", () => {
    const next = appendAssetPage(EMPTY_ASSET_LIST, page(["a", "b"], "c-1"));
    expect(next.items.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(next.cursor).toBe("c-1");
  });

  it("第二页接在后面，重叠的那条不再出现一次", () => {
    const first = appendAssetPage(EMPTY_ASSET_LIST, page(["a", "b"], "c-1"));
    const second = appendAssetPage(first, page(["b", "c"], "c-2"));
    expect(second.items.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(second.cursor).toBe("c-2");
  });

  it("nextCursor 为 null 时收掉游标", () => {
    const first = appendAssetPage(EMPTY_ASSET_LIST, page(["a"], "c-1"));
    expect(appendAssetPage(first, page(["b"], null)).cursor).toBeNull();
  });

  it("游标不前进就当到底，不让「加载更多」永远可点", () => {
    const first = appendAssetPage(EMPTY_ASSET_LIST, page(["a"], "c-1"));
    const stuck = appendAssetPage(first, page(["b"], "c-1"));
    expect(stuck.items.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(stuck.cursor).toBeNull();
  });

  it("整页都是重复的时候不动 items 引用（避免白白重渲染）", () => {
    const first = appendAssetPage(EMPTY_ASSET_LIST, page(["a"], "c-1"));
    const again = appendAssetPage(first, page(["a"], "c-2"));
    expect(again.items).toBe(first.items);
    expect(again.cursor).toBe("c-2");
  });

  it("空页只更新游标", () => {
    const first = appendAssetPage(EMPTY_ASSET_LIST, page(["a"], "c-1"));
    expect(appendAssetPage(first, page([], null))).toEqual({ items: first.items, cursor: null });
  });
});

describe("formatAssetSize", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [1024 * 1024, "1 MB"],
    [1024 * 1024 * 2.25, "2.3 MB"],
    [1024 * 1024 * 1024 * 3, "3 GB"],
    // 超过 GB 不再进位：素材库里不会有 TB 级单文件，多一档反而多一处四舍五入。
    [1024 * 1024 * 1024 * 2048, "2048 GB"],
  ])("%i → %s", (bytes, expected) => {
    expect(formatAssetSize(bytes)).toBe(expected);
  });

  it.each([null, Number.NaN, -1])("拿不到体积时给空串：%s", (value) => {
    expect(formatAssetSize(value)).toBe("");
  });
});

describe("formatAssetDuration", () => {
  it.each([
    [0, "0:00"],
    [8, "0:08"],
    [59, "0:59"],
    [60, "1:00"],
    [61, "1:01"],
    [599, "9:59"],
    [3600, "1:00:00"],
    [3661, "1:01:01"],
    [12.4, "0:12"],
    [12.6, "0:13"],
  ])("%s 秒 → %s", (seconds, expected) => {
    expect(formatAssetDuration(seconds)).toBe(expected);
  });

  it.each([null, Number.NaN, -1])("拿不到时长时给空串：%s", (value) => {
    expect(formatAssetDuration(value)).toBe("");
  });
});
