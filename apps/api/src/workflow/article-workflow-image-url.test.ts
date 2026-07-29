import { describe, expect, it } from "vitest";
import {
  articleWorkflowImageBlobUrl,
  articleWorkflowStorableImageUrl,
} from "./article-workflow-image-url.js";

const DATA_URL = `data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`;
const OBJECT_KEY = "workflow/images/u1/article-1/cover.png";

describe("articleWorkflowStorableImageUrl", () => {
  it("字节已进对象存储时，data URL 换成 API 代理地址", () => {
    expect(articleWorkflowStorableImageUrl({ url: DATA_URL, assetId: "asset-9", objectKey: OBJECT_KEY }))
      .toBe("/api/workflow/article-workflow/images/asset-9/blob");
  });

  it("没配对象存储时保留 data URL：那是图片的唯一副本，换掉就是把图弄丢", () => {
    expect(articleWorkflowStorableImageUrl({ url: DATA_URL, assetId: "asset-9", objectKey: null }))
      .toBe(DATA_URL);
  });

  it("没有 assetId 就取不回字节，同样保留 data URL", () => {
    expect(articleWorkflowStorableImageUrl({ url: DATA_URL, assetId: null, objectKey: OBJECT_KEY }))
      .toBe(DATA_URL);
  });

  it("http(s) 地址原样保留——线上配了公网前缀就是这个形态，也是公众号能用的形态", () => {
    const url = "https://cdn.example.com/workflow/images/u1/a.png";
    expect(articleWorkflowStorableImageUrl({ url, assetId: "asset-9", objectKey: OBJECT_KEY })).toBe(url);
  });

  it("未出图的空地址保持空，不会被伪造成代理地址", () => {
    expect(articleWorkflowStorableImageUrl({ url: "  ", assetId: "asset-9", objectKey: OBJECT_KEY })).toBe("");
  });

  it("幂等：代理地址再过一遍还是它自己", () => {
    const once = articleWorkflowStorableImageUrl({ url: DATA_URL, assetId: "asset-9", objectKey: OBJECT_KEY });
    expect(articleWorkflowStorableImageUrl({ url: once, assetId: "asset-9", objectKey: OBJECT_KEY })).toBe(once);
  });

  it("assetId 里的特殊字符要转义，避免拼出畸形路径", () => {
    expect(articleWorkflowImageBlobUrl("a/b?c")).toBe("/api/workflow/article-workflow/images/a%2Fb%3Fc/blob");
  });
});
