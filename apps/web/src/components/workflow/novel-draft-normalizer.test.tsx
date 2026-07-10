import { describe, expect, it } from "vitest";
import { normalizeNovelDraftText } from "./novelDraftNormalizer";

describe("normalizeNovelDraftText", () => {
  it("maps legacy structured JSON into editable macro field blocks", () => {
    const text = JSON.stringify({
      title: "长夜纪元",
      stage: "macro",
      story_engine: "主角靠治愈异能破局。",
      main_line: "从村医逆袭到资源掌控者。",
      long_conflict: "主角阵营与地方恶霸持续斗争。",
      rhythm: "每 5 章一个小循环。",
      first_30_chapters: ["第1章：危机。", "第2章：压迫。"],
    });

    const result = normalizeNovelDraftText("macro", text, ["故事引擎", "主线", "长期对立", "节奏底盘", "前30章承诺"]);

    expect(result).toContain("【故事引擎】\n主角靠治愈异能破局。");
    expect(result).toContain("【主线】\n从村医逆袭到资源掌控者。");
    expect(result).toContain("【前30章承诺】\n第1章：危机。\n第2章：压迫。");
    expect(result).not.toContain("story_engine");
    expect(result).not.toContain("长夜纪元");
  });

  it("maps generated settings JSON into all editable setting fields", () => {
    const text = JSON.stringify({
      coreRequirement: "视角：第三人称；节奏强爽。",
      channel: "女频长篇",
      platforms: ["番茄", "起点"],
      topics: ["玄幻", "宅斗"],
      perspective: "第三人称",
      styleMode: "强爽点",
      era: "古代",
      hasCheat: "否",
      styleTags: ["升级流", "打脸文"],
      language: "中文",
      chapterPlan: { count: 12, chars: 5000 },
      sellingPoints: "从底层逆袭到掌权。",
      targetReaders: "18-35 岁女性读者。",
      first30Chapters: ["第1章：陷入危机。", "第2章：第一重压迫。"],
    });

    const result = normalizeNovelDraftText("settings", text, [
      "核心要求",
      "频道",
      "平台",
      "题材",
      "视角",
      "文风模式",
      "年代",
      "是否金手指",
      "风格标签",
      "语言",
      "章节规划",
      "卖点",
      "目标读者",
      "前30章承诺",
    ]);

    expect(result).toContain("【核心要求】\n视角：第三人称；节奏强爽。");
    expect(result).toContain("【频道】\n女频长篇");
    expect(result).toContain("【平台】\n番茄\n起点");
    expect(result).toContain("【章节规划】\n12\n5000");
    expect(result).toContain("【目标读者】\n18-35 岁女性读者。");
    expect(result).not.toContain("coreRequirement");
  });

  it("maps plain generated section text into editable field blocks", () => {
    const text = [
      "故事引擎：治愈异能驱动乡村种田与权谋复仇循环。",
      "",
      "主线",
      "主角从乡村底层逆袭，逐步掌控资源、组织与舆论。",
      "",
      "长期对立：主角阵营与地方恶霸持续斗争。",
      "",
      "节奏底盘",
      "每 5-10 章一个小循环：困局、破局、收益、反扑、升级。",
      "",
      "前 30 章承诺（每行一条）",
      "第1章：赤脚医生的隐忍",
      "第2章：枯井边的生死一刻",
    ].join("\n");

    const result = normalizeNovelDraftText("macro", text, ["故事引擎", "主线", "长期对立", "节奏底盘", "前30章承诺"]);

    expect(result).toContain("【故事引擎】\n治愈异能驱动乡村种田与权谋复仇循环。");
    expect(result).toContain("【主线】\n主角从乡村底层逆袭，逐步掌控资源、组织与舆论。");
    expect(result).toContain("【前30章承诺】\n第1章：赤脚医生的隐忍\n第2章：枯井边的生死一刻");
  });

  it("formats generated character JSON into editable character cards", () => {
    const text = JSON.stringify({
      characters: [
        {
          name: "李阳",
          "身份锚点": "乡村赤脚医生，治愈异能觉醒者。",
          motivation: "护住家人并夺回村庄资源。",
          relationships: ["赵虎：压迫与反抗", "父母：守护与亏欠"],
        },
      ],
      relationshipMap: ["李阳 ↔ 赵虎：直接冲突。"],
    });

    const result = normalizeNovelDraftText("chars", text, ["角色", "关系网"]);

    expect(result).toContain("【角色】\n李阳");
    expect(result).toContain("身份锚点：乡村赤脚医生，治愈异能觉醒者。");
    expect(result).toContain("动机：护住家人并夺回村庄资源。");
    expect(result).toContain("关系：赵虎：压迫与反抗、父母：守护与亏欠");
    expect(result).toContain("【关系网】\n李阳 ↔ 赵虎：直接冲突。");
    expect(result).not.toContain("characters");
    expect(result).not.toContain("motivation");
  });

  it("keeps every generated character as an independent editable block", () => {
    const text = JSON.stringify({
      characters: [
        { name: "李阳", identity: "赤脚医生。", motivation: "护村。" },
        { name: "赵虎", identity: "地方恶霸。", motivation: "控制资源。" },
      ],
    });

    const result = normalizeNovelDraftText("chars", text, ["角色", "关系网"]);
    const roleText = result.match(/【角色】\n([\s\S]*?)(?:\n\n【关系网】|$)/)?.[1] ?? "";

    expect(roleText.split(/\n{2,}/)).toEqual([
      "李阳\n身份锚点：赤脚医生。\n动机：护村。",
      "赵虎\n身份锚点：地方恶霸。\n动机：控制资源。",
    ]);
  });

  it("keeps every generated volume as an independent editable block", () => {
    const text = JSON.stringify({
      volumes: [
        { title: "觉醒之始", strategy: "建立主角隐忍背景。", skeleton: "开端、冲突、觉醒。" },
        { title: "种田兴家", strategy: "推进经营扩张。", skeleton: "资源、合作、反扑。" },
      ],
    });

    const result = normalizeNovelDraftText("volumes", text, ["分卷"]);

    expect(result).toBe([
      "【分卷】",
      "标题：觉醒之始\n战略：建立主角隐忍背景。\n骨架：开端、冲突、觉醒。",
      "",
      "标题：种田兴家\n战略：推进经营扩张。\n骨架：资源、合作、反扑。",
    ].join("\n"));
  });

  it("keeps top-level volume arrays as independent editable blocks", () => {
    const text = JSON.stringify([
      { title: "觉醒之始", strategy: "建立主角隐忍背景。", skeleton: "开端、冲突、觉醒。" },
      { title: "种田兴家", strategy: "推进经营扩张。", skeleton: "资源、合作、反扑。" },
    ]);

    const result = normalizeNovelDraftText("volumes", text, ["分卷"]);

    expect(result).toBe([
      "【分卷】",
      "标题：觉醒之始\n战略：建立主角隐忍背景。\n骨架：开端、冲突、觉醒。",
      "",
      "标题：种田兴家\n战略：推进经营扩张。\n骨架：资源、合作、反扑。",
    ].join("\n"));
  });

  it("keeps every generated chapter outline as an independent editable block", () => {
    const text = JSON.stringify({
      chapters: [
        { index: 1, title: "赤脚医生的隐忍", summary: "暴雨夜守住底线。", goal: "建立压迫感。" },
        { index: 2, title: "枯井边的生死一刻", summary: "治愈异能觉醒。", goal: "引出能力。" },
      ],
    });

    const result = normalizeNovelDraftText("outline", text, ["章节列表"]);

    expect(result).toBe([
      "【章节列表】",
      "序号：1\n标题：赤脚医生的隐忍\n摘要：暴雨夜守住底线。\n本章目标：建立压迫感。",
      "",
      "序号：2\n标题：枯井边的生死一刻\n摘要：治愈异能觉醒。\n本章目标：引出能力。",
    ].join("\n"));
  });

  it("keeps top-level chapter arrays as independent editable blocks", () => {
    const text = JSON.stringify([
      { index: 1, title: "赤脚医生的隐忍", summary: "暴雨夜守住底线。", goal: "建立压迫感。" },
      { index: 2, title: "枯井边的生死一刻", summary: "治愈异能觉醒。", goal: "引出能力。" },
    ]);

    const result = normalizeNovelDraftText("outline", text, ["章节列表"]);

    expect(result).toBe([
      "【章节列表】",
      "序号：1\n标题：赤脚医生的隐忍\n摘要：暴雨夜守住底线。\n本章目标：建立压迫感。",
      "",
      "序号：2\n标题：枯井边的生死一刻\n摘要：治愈异能觉醒。\n本章目标：引出能力。",
    ].join("\n"));
  });

  it("repairs legacy character fields that already contain wrapped JSON", () => {
    const text = [
      "【角色】",
      JSON.stringify({
        角色: [
          { 名: "沈九泠", 类: "主角", 年: "十七岁", 动: "夺回家族资源。" },
          { 名: "赵虎", 类: "反派", 动: "控制村庄。" },
        ],
      }),
      "",
      "【关系网】",
      "沈九泠 ↔ 赵虎：压迫与反抗。",
    ].join("\n");

    const result = normalizeNovelDraftText("chars", text, ["角色", "关系网"]);

    expect(result).toContain("【角色】\n沈九泠");
    expect(result).toContain("动机：夺回家族资源。");
    expect(result).toContain("\n\n赵虎\n");
    expect(result).toContain("【关系网】\n沈九泠 ↔ 赵虎：压迫与反抗。");
    expect(result).not.toContain("\"角色\"");
  });

  it("repairs wrapped volume JSON into one editable block per volume", () => {
    const text = [
      "【分卷】",
      JSON.stringify({
        分卷: [
          {
            卷名: "第一卷·寒泉烬",
            主题: "绝境求生",
            主线目标: "从寒泉别院活着出来。",
            核心事件: ["摸清威胁", "踏上偷修之路"],
          },
          {
            卷名: "第二卷·孤城火",
            主题: "夺回资源",
            主线目标: "建立第一支队伍。",
          },
        ],
      }),
    ].join("\n");

    const result = normalizeNovelDraftText("volumes", text, ["分卷"]);

    expect(result).toContain("【分卷】\n标题：第一卷·寒泉烬");
    expect(result).toContain("战略：绝境求生");
    expect(result).toContain("骨架：摸清威胁、踏上偷修之路");
    expect(result).toContain("\n\n标题：第二卷·孤城火");
    expect(result).not.toContain("\"分卷\"");
  });

  it("repairs compact chapter list JSON into one editable block per chapter", () => {
    const text = `【章节列表】\n${JSON.stringify({
      章节列表: [
        { 章号: 1, 标题: "寒泉院", 目的: "女主觉醒第一个保命技能。", 冲突: "管事逼迫。" },
        { 章号: 2, 标题: "冷铁铃", 目的: "建立反击线索。", 字数: 2300 },
      ],
    })}`;

    const result = normalizeNovelDraftText("outline", text, ["章节列表"]);

    expect(result).toContain("【章节列表】\n序号：1");
    expect(result).toContain("标题：寒泉院");
    expect(result).toContain("本章目标：女主觉醒第一个保命技能。");
    expect(result).toContain("\n\n序号：2");
    expect(result).not.toContain("\"章节列表\"");
  });

  it("does not echo truncated legacy JSON for chapter outlines", () => {
    const text = "{\"章节列表\":[{\"章号\":1,\"标题\":\"寒泉院\"";

    const result = normalizeNovelDraftText("outline", text, ["章节列表"]);

    expect(result).toBe("生成结果不完整，请重新生成。");
    expect(result).not.toContain("\"章节列表\"");
  });

  it("does not echo truncated wrapped legacy JSON for volumes", () => {
    const text = "【分卷】\n{\"分卷\":[{\"卷名\":\"第一卷·寒泉烬\"";

    const result = normalizeNovelDraftText("volumes", text, ["分卷"]);

    expect(result).toBe("【分卷】\n生成结果不完整，请重新生成。");
    expect(result).not.toContain("\"分卷\"");
  });
});
