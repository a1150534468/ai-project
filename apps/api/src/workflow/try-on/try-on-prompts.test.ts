import { describe, expect, it } from "vitest";
import { buildTryOnPrompt } from "./try-on-prompts.js";

describe("buildTryOnPrompt", () => {
  it("labels generic item references and creates a suitable subject when none is supplied", () => {
    const prompt = buildTryOnPrompt({
      aspectRatio: "3:4",
      hasItemDetail: true,
      hasSubjectReference: false,
      description: "把复古台灯自然装到机器人肩上，明亮影棚",
    });
    expect(prompt).toContain("参考图 1 是必须准确还原并应用到画面中的目标素材");
    expect(prompt).toContain("参考图 2 是同一目标素材的补充角度或细节图");
    expect(prompt).toContain("主体可以是人物、动物、物体或空间");
    expect(prompt).toContain("不要把非服装素材强行解释为服装");
    expect(prompt).toContain("补充描述：把复古台灯自然装到机器人肩上，明亮影棚");
    expect(prompt).toContain("画面比例：3:4");
  });

  it("uses the final reference as a person, animal, object, or space and preserves unrelated content", () => {
    const prompt = buildTryOnPrompt({ aspectRatio: "9:16", hasItemDetail: true, hasSubjectReference: true });
    expect(prompt).toContain("参考图 3 是承载试穿效果的主体图");
    expect(prompt).toContain("若主体是人物");
    expect(prompt).toContain("若主体是动物、物体或空间");
    expect(prompt).toContain("只修改应用目标素材所必需的区域");
    expect(prompt).toContain("原发型、穿搭、妆容和其他特征只在与目标效果冲突时改变");
    expect(prompt).toContain("不要将新旧元素错误叠加或混合");
    expect(prompt).toContain("目标素材还原是最高优先级");
  });
});
