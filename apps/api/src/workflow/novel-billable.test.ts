import { describe, expect, it } from "vitest";
import { billableCharCount, extractBillableText, formatGeneratedNovelDisplayText, visibleCharCount } from "./novel-billable.js";

describe("novel billable text", () => {
  it("counts visible unicode characters and ignores whitespace", () => {
    expect(visibleCharCount("世 界\nA!")).toBe(4);
  });

  it("counts structured worldbuilding JSON by displayed values only", () => {
    const raw = JSON.stringify({
      title: "星海纪元",
      rules: ["灵能守恒", "跃迁需付出记忆"],
      factions: [{ name: "巡星会", brief: "维护航道" }],
    });

    expect(extractBillableText("world", raw)).not.toContain("星海纪元");
    expect(extractBillableText("world", raw)).not.toContain("title");
    expect(billableCharCount("world", raw)).toBe(18);
  });

  it("formats structured planning JSON into editable field blocks", () => {
    const raw = JSON.stringify({
      title: "长夜纪元",
      stage: "macro",
      story_engine: "主角靠治愈异能破局。",
      main_line: "从村医逆袭到资源掌控者。",
      long_conflict: "主角阵营与地方恶霸持续斗争。",
      rhythm: "每 5 章一个困局、破局、收益、反扑的小循环。",
      first_30_chapters: ["第1章：主角陷入危机。", "第2章：揭示第一重压迫关系。"],
    });

    const displayText = formatGeneratedNovelDisplayText("macro", raw);

    expect(displayText).toContain("【故事引擎】\n主角靠治愈异能破局。");
    expect(displayText).toContain("【主线】\n从村医逆袭到资源掌控者。");
    expect(displayText).toContain("【长期对立】\n主角阵营与地方恶霸持续斗争。");
    expect(displayText).toContain("【节奏底盘】\n每 5 章一个困局、破局、收益、反扑的小循环。");
    expect(displayText).toContain("【前30章承诺】\n第1章：主角陷入危机。\n第2章：揭示第一重压迫关系。");
    expect(displayText).not.toContain("story_engine");
    expect(displayText).not.toContain("长夜纪元");
  });

  it("formats generated settings JSON into all editable setting field blocks", () => {
    const raw = JSON.stringify({
      coreRequirement: "第三人称，强爽节奏。",
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
      sellingPoints: "底层女主逆袭掌权。",
      targetReaders: "18-35 岁女性读者。",
      first30Chapters: ["第1章：陷入危机。", "第2章：压迫升级。"],
    });

    const displayText = formatGeneratedNovelDisplayText("settings", raw);

    expect(displayText).toContain("【核心要求】\n第三人称，强爽节奏。");
    expect(displayText).toContain("【频道】\n女频长篇");
    expect(displayText).toContain("【平台】\n番茄\n起点");
    expect(displayText).toContain("【章节规划】\n12\n5000");
    expect(displayText).toContain("【目标读者】\n18-35 岁女性读者。");
    expect(displayText).not.toContain("coreRequirement");
  });

  it("formats plain generated section text into editable field blocks", () => {
    const raw = [
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

    const displayText = formatGeneratedNovelDisplayText("macro", raw);

    expect(displayText).toContain("【故事引擎】\n治愈异能驱动乡村种田与权谋复仇循环。");
    expect(displayText).toContain("【主线】\n主角从乡村底层逆袭，逐步掌控资源、组织与舆论。");
    expect(displayText).toContain("【前30章承诺】\n第1章：赤脚医生的隐忍\n第2章：枯井边的生死一刻");
  });

  it("extracts JSON fragments from fenced model text before counting", () => {
    const raw = "```json\n{\"name\":\"林岚\",\"motivation\":\"夺回故乡\"}\n```";

    expect(extractBillableText("chars", raw)).toBe("林岚\n夺回故乡");
    expect(billableCharCount("chars", raw)).toBe(6);
  });

  it("formats generated character JSON into readable character cards", () => {
    const raw = JSON.stringify({
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

    const displayText = formatGeneratedNovelDisplayText("chars", raw);

    expect(displayText).toContain("【角色】\n李阳");
    expect(displayText).toContain("身份锚点：乡村赤脚医生，治愈异能觉醒者。");
    expect(displayText).toContain("动机：护住家人并夺回村庄资源。");
    expect(displayText).toContain("关系：赵虎：压迫与反抗、父母：守护与亏欠");
    expect(displayText).toContain("【关系网】\n李阳 ↔ 赵虎：直接冲突。");
    expect(displayText).not.toContain("characters");
    expect(displayText).not.toContain("motivation");
  });

  it("formats wrapped character JSON from model text into readable cards", () => {
    const raw = [
      "【角色】",
      JSON.stringify({
        角色: [
          { 名: "沈九泠", 类: "主角", 年: "十七岁", 动: "夺回家族资源。" },
          { 名: "赵虎", 类: "反派", 动: "控制村庄。" },
        ],
      }),
    ].join("\n");

    const displayText = formatGeneratedNovelDisplayText("chars", raw);

    expect(displayText).toContain("【角色】\n沈九泠");
    expect(displayText).toContain("动机：夺回家族资源。");
    expect(displayText).toContain("\n\n赵虎\n");
    expect(displayText).not.toContain("\"角色\"");
  });

  it("formats generated volume JSON into one block per volume", () => {
    const raw = JSON.stringify({
      分卷: [
        { 卷名: "第一卷·寒泉烬", 主题: "绝境求生", 主线目标: "活着离开别院。", 核心事件: ["摸清威胁", "踏上偷修之路"] },
        { 卷名: "第二卷·孤城火", 主题: "夺回资源", 主线目标: "建立第一支队伍。" },
      ],
    });

    const displayText = formatGeneratedNovelDisplayText("volumes", raw);

    expect(displayText).toContain("【分卷】\n标题：第一卷·寒泉烬");
    expect(displayText).toContain("战略：绝境求生");
    expect(displayText).toContain("骨架：摸清威胁、踏上偷修之路");
    expect(displayText).toContain("\n\n标题：第二卷·孤城火");
    expect(displayText).not.toContain("\"分卷\"");
  });

  it("formats top-level volume arrays as editable volume blocks", () => {
    const raw = JSON.stringify([
      { 卷号: 1, 标题: "寒泉烬", 战略: "绝境求生", 骨架: "摸清威胁。" },
      { 卷号: 2, 标题: "孤城火", 战略: "夺回资源", 骨架: "建立队伍。" },
    ]);

    const displayText = formatGeneratedNovelDisplayText("volumes", raw);

    expect(displayText).toContain("【分卷】\n标题：寒泉烬");
    expect(displayText).toContain("战略：绝境求生");
    expect(displayText).toContain("\n\n标题：孤城火");
    expect(displayText).not.toContain("\"寒泉烬\"");
  });

  it("formats generated chapter list JSON into one block per chapter", () => {
    const raw = JSON.stringify({
      章节列表: [
        { 章号: 1, 标题: "寒泉院", 目的: "女主觉醒第一个保命技能。", 冲突: "管事逼迫。" },
        { 章号: 2, 标题: "冷铁铃", 目的: "建立反击线索。", 字数: 2300 },
      ],
    });

    const displayText = formatGeneratedNovelDisplayText("outline", raw);

    expect(displayText).toContain("【章节列表】\n序号：1");
    expect(displayText).toContain("标题：寒泉院");
    expect(displayText).toContain("本章目标：女主觉醒第一个保命技能。");
    expect(displayText).toContain("\n\n序号：2");
    expect(displayText).not.toContain("\"章节列表\"");
  });

  it("formats top-level chapter arrays as editable chapter blocks", () => {
    const raw = JSON.stringify([
      { 章号: 1, 标题: "寒泉院", 目的: "女主觉醒第一个保命技能。", 冲突: "管事逼迫。" },
      { 章号: 2, 标题: "冷铁铃", 目的: "建立反击线索。", 字数: 2300 },
    ]);

    const displayText = formatGeneratedNovelDisplayText("outline", raw);

    expect(displayText).toContain("【章节列表】\n序号：1");
    expect(displayText).toContain("标题：寒泉院");
    expect(displayText).toContain("本章目标：女主觉醒第一个保命技能。");
    expect(displayText).toContain("\n\n序号：2");
    expect(displayText).not.toContain("\"寒泉院\"");
  });

  it("counts chapter body by final content field", () => {
    const raw = { title: "第一章", content: "雨夜里，林岚推开旧门。" };

    expect(extractBillableText("chapter", raw)).toBe("雨夜里，林岚推开旧门。");
    expect(billableCharCount("chapter", raw)).toBe(11);
  });
});
