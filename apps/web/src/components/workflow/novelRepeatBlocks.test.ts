import { describe, expect, it } from "vitest";
import { appendRepeatBlock, composeRepeatBlocks, splitRepeatBlocks, updateRepeatBlock } from "./novelRepeatBlocks";

describe("novel repeat blocks", () => {
  it("splits role, volume, and chapter text by blank-line item boundaries", () => {
    const value = [
      "李阳\n身份锚点：赤脚医生。",
      "",
      "赵虎\n身份锚点：地方恶霸。",
    ].join("\n");

    expect(splitRepeatBlocks(value)).toEqual([
      "李阳\n身份锚点：赤脚医生。",
      "赵虎\n身份锚点：地方恶霸。",
    ]);
  });

  it("keeps at least one editable block and composes non-empty blocks", () => {
    expect(splitRepeatBlocks("  ")).toEqual([""]);
    expect(composeRepeatBlocks([" 第一卷 ", "", " 第二卷 "])).toBe("第一卷\n\n第二卷");
  });

  it("updates one block without flattening the others", () => {
    const value = "第一卷\n战略：开局\n\n第二卷\n战略：升级";

    expect(updateRepeatBlock(value, 1, "第二卷\n战略：反扑")).toBe("第一卷\n战略：开局\n\n第二卷\n战略：反扑");
  });

  it("appends a prepared block for the add button", () => {
    expect(appendRepeatBlock("", "标题：新分卷\n战略：")).toBe("标题：新分卷\n战略：");
    expect(appendRepeatBlock("第一卷", "标题：第二卷")).toBe("第一卷\n\n标题：第二卷");
  });
});
