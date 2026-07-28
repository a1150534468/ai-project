import { describe, expect, it } from "vitest";
import { parseArticleWorkflowTagsInput } from "./ArticleWorkflowCaptionEditor";
import { articleWorkflowTagsText } from "./articleWorkflowCopyActions";
import { articleWorkflowImageFileName, articleWorkflowImageRatioLabel } from "./articleWorkflowImageDownload";

describe("articleWorkflowImageRatioLabel", () => {
  it("reduces platform sizes to plain ratios", () => {
    expect(articleWorkflowImageRatioLabel("1536x864")).toBe("16:9");
    expect(articleWorkflowImageRatioLabel("768x1024")).toBe("3:4");
    expect(articleWorkflowImageRatioLabel("864x1536")).toBe("9:16");
    expect(articleWorkflowImageRatioLabel("1024x768")).toBe("4:3");
  });

  it("returns empty string for unparseable sizes", () => {
    expect(articleWorkflowImageRatioLabel("")).toBe("");
    expect(articleWorkflowImageRatioLabel("auto")).toBe("");
    expect(articleWorkflowImageRatioLabel("0x1024")).toBe("");
  });
});

describe("articleWorkflowImageFileName", () => {
  it("keeps the upstream extension and prefixes the platform", () => {
    expect(articleWorkflowImageFileName({
      platform: "xiaohongshu",
      slot: "cover",
      url: "https://cdn.test/a/b.webp?x=1",
    })).toBe("xiaohongshu-cover.webp");
  });

  it("normalizes jpeg to jpg and defaults to png", () => {
    expect(articleWorkflowImageFileName({
      platform: "wechat",
      slot: "inline-1",
      url: "https://cdn.test/a.jpeg",
    })).toBe("wechat-inline-1.jpg");
    expect(articleWorkflowImageFileName({
      platform: "douyin",
      slot: "cover",
      url: "https://cdn.test/no-extension",
    })).toBe("douyin-cover.png");
  });

  it("infers the extension from data urls and sanitizes the slot", () => {
    expect(articleWorkflowImageFileName({
      platform: "wechat",
      slot: "inline 2/x",
      url: "data:image/jpeg;base64,AAAA",
    })).toBe("wechat-inline-2-x.jpg");
  });
});

describe("caption tags text round trip", () => {
  it("renders tags with a leading hash", () => {
    expect(articleWorkflowTagsText(["咖啡机", "#居家好物", " 夏日饮品 "]))
      .toBe("#咖啡机 #居家好物 #夏日饮品");
  });

  it("parses hashes and mixed separators back into bare tags", () => {
    expect(parseArticleWorkflowTagsInput("#咖啡机 #居家好物，夏日饮品、露营\n通勤"))
      .toEqual(["咖啡机", "居家好物", "夏日饮品", "露营", "通勤"]);
  });

  it("survives a render/parse round trip", () => {
    const tags = ["咖啡机", "居家好物"];
    expect(parseArticleWorkflowTagsInput(articleWorkflowTagsText(tags))).toEqual(tags);
  });
});
