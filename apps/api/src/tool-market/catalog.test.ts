import { describe, expect, it } from "vitest";
import { findMarketSkill, listMarketCategories, listMarketSkills } from "./catalog.js";

describe("tool market catalog", () => {
  it("复用 yun-claw skill 市场的 32 个分类索引", () => {
    const categories = listMarketCategories();
    expect(categories).toHaveLength(32);
    expect(categories[0]).toMatchObject({
      key: "productivity-tasks",
      label: "办公效率",
    });
  });

  it("可按分类读取并定位 skill", () => {
    const finance = listMarketSkills("finance");
    expect(finance.key).toBe("finance");
    expect(finance.skills[0]).toMatchObject({
      id: "10270",
      name: "投资社区",
    });
    expect(findMarketSkill("finance", "10270")).toMatchObject({
      id: "10270",
      name: "投资社区",
    });
  });
});
