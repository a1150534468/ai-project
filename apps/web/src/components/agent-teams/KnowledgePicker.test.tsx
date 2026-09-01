// @vitest-environment jsdom

/**
 * P4.2 给智能体团队侧的知识库选择器补的第一个用例（改之前这个组件零覆盖）。
 *
 * 盯住的是「自动挂载你自己创建的 N 个知识库」这句文案里的 N：它必须只数
 * `ownerType === "USER"` 的库，而不是 `knowledgeBases.length`。理由是服务端「全库」
 * 的取值范围就是这个谓词（`kb/retrieve.ts` 的 `resolveEffectiveKbIds`：
 * `ownerType='USER' AND userId=本人`），官方库只有被显式勾中才进检索。
 * 数字和检索范围一旦不同口径，这句话就是在承诺一个全库搜索不会碰的库。
 *
 * 同时钉住 P2 的成果：产物系统库（`systemKey='AI_ARTIFACTS'`）当年是 `ownerType='USER'`
 * 且 userId 是本人，所以它就在这份列表里、带「我的」角标、计进 N。选择器从来没有
 * `systemKey` 过滤也不需要加 —— 那些行已经删了，列表里的「我的」库现在就该真是自建的。
 */

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KnowledgePicker } from "./KnowledgePicker";

function kb(id: string, name: string, ownerType = "USER") {
  return { id, name, ownerType, latticeCount: 0 };
}

describe("agent-teams KnowledgePicker", () => {
  it("「你自己创建的 N 个」只数自己的库：官方库列得出来但不计数", () => {
    const view = render(
      <KnowledgePicker
        knowledgeBases={[kb("kb-1", "合同知识库"), kb("kb-2", "行业报告", "OFFICIAL"), kb("kb-3", "会议记录")]}
        selectedKbIds={[]}
        attachAllOwn={false}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(view.getByText("挂载知识库", { selector: "span" }));

    expect(view.container.textContent).toContain("你自己创建的 2 个知识库");
    expect(view.getByText("合同知识库")).toBeTruthy();
    expect(view.getByText("会议记录")).toBeTruthy();
    expect(view.getByText("行业报告")).toBeTruthy();
    expect(view.getAllByText("我的")).toHaveLength(2);
    expect(view.getAllByText("官方")).toHaveLength(1);
  });

  it("勾选具体库会让全库搜索让位，确定时只回传 kbIds", () => {
    const onChange = vi.fn();
    const view = render(
      <KnowledgePicker
        knowledgeBases={[kb("kb-1", "合同知识库"), kb("kb-2", "行业报告", "OFFICIAL")]}
        selectedKbIds={[]}
        attachAllOwn
        onChange={onChange}
      />,
    );

    fireEvent.click(view.getByText("我的全库搜索", { selector: "span" }));
    fireEvent.click(view.getByText("行业报告"));
    fireEvent.click(view.getByText("确定"));

    expect(onChange).toHaveBeenCalledWith({ attachAllOwn: false, kbIds: ["kb-2"] });
  });
});
