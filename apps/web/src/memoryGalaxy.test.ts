import { describe, expect, it } from "vitest";
import { MEMORY_TYPE_ORDER, fallbackTitle, getMemoryTypeMeta } from "./memoryGalaxy";

describe("getMemoryTypeMeta", () => {
  it("五类记忆按展示顺序各有一个中文名", () => {
    expect(MEMORY_TYPE_ORDER.map((type) => getMemoryTypeMeta(type).label)).toEqual([
      "核心记忆",
      "常驻记忆",
      "临时记忆",
      "知识星云",
      "其他记忆",
    ]);
  });
});

const LONG_TITLE = "一二三四五六七八九十".repeat(3);

const TITLE_PROBES = [
  { what: "有标题就用标题，顺手去掉首尾空白", title: "  核心偏好  ", text: "正文", want: "核心偏好" },
  { what: "标题空了退回正文", title: "", text: "用户正在做 OpenClaw 云端项目", want: "用户正在做 OpenClaw 云端项目" },
  { what: "只有空白的标题也算空", title: "   \n ", text: "退回正文", want: "退回正文" },
  { what: "两边都空才给占位名", title: "", text: "", want: "未命名记忆" },
  { what: "超过 24 字截断加省略号", title: LONG_TITLE, text: "", want: `${LONG_TITLE.slice(0, 24)}...` },
  { what: "换行与连续空格折成一个空格", title: "上半句\n\n下半句", text: "", want: "上半句 下半句" },
  { what: "全角空格经 NFKC 归一后一样被折掉", title: "　全角　标题　", text: "", want: "全角 标题" },
] as const;

describe("fallbackTitle", () => {
  for (const probe of TITLE_PROBES) {
    it(probe.what, () => {
      expect(fallbackTitle(probe.title, probe.text)).toBe(probe.want);
    });
  }
});
