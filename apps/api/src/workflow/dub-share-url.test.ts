import { describe, it, expect } from "vitest";
import { extractShareUrl } from "./dub-share-url.js";

describe("extractShareUrl", () => {
  it("从抖音分享文案抽出链接", () => {
    const text =
      "0.76 复制打开抖音，看看【谁偷了我的大电】官方的超燃变装 https://v.douyin.com/5mwYGHdaFPs/ 06/16 bAg:/";
    expect(extractShareUrl(text)).toBe("https://v.douyin.com/5mwYGHdaFPs/");
  });

  it("纯 URL 原样返回", () => {
    expect(extractShareUrl("https://v.douyin.com/abc")).toBe("https://v.douyin.com/abc");
  });

  it("剥掉尾部中文标点/括号", () => {
    expect(extractShareUrl("看这个（https://v.douyin.com/abc），很燃")).toBe("https://v.douyin.com/abc");
  });

  it("多个链接取第一个", () => {
    expect(extractShareUrl("a https://a.com/1 b https://b.com/2")).toBe("https://a.com/1");
  });

  it("无链接返回 null", () => {
    expect(extractShareUrl("没有任何链接的文案")).toBeNull();
  });
});
