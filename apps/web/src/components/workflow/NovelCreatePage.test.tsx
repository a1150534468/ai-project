// @vitest-environment jsdom

/**
 * 建档页自己的用例。这个组件是纯受控的：草稿在上层，它只负责画表单、把改动交回去，所以用例都用一个
 * 拿着 `useState` 的壳子包一层，断言落在「交回去的那份草稿」上。
 *
 * 为什么新开这个文件：`NovelWorkflowStudio.test.tsx` 上一版是 `renderToStaticMarkup` + `toContain`，
 * 用建档页的文案（故事梗概 / 市场分区 / 目标篇幅 / 建档并进入设置向导）来证明「书库长对了」。
 * 那种断言只能证明字符串出现过，市场分区推导没推、篇幅档位没写进草稿它一概不知道。现在容器的用例
 * 把三个子页面全换成探针，那几条文案断言就搬到这里，改成对真组件的行为断言。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultNovelDraft,
  hasNovelPremise,
  NovelCreatePage,
  novelCreateGenre,
  novelCreateTitle,
  type NovelCreateDraft,
} from "./NovelCreatePage";

const PREMISE = "被逐出宗门的阵法师要在王朝封锁前修复失落阵图。";

/** 壳子每次渲染都把当下的草稿露出来，测试直接读它，不用再从 `onChange` 的调用记录里拼。 */
const seen = { draft: createDefaultNovelDraft() };

function Harness({ isSubmitting = false, onSubmit = () => undefined }) {
  const [draft, setDraft] = useState(seen.draft);
  seen.draft = draft;
  return <NovelCreatePage draft={draft} isSubmitting={isSubmitting} onChange={setDraft} onSubmit={onSubmit} />;
}

function premiseBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/用一段话写清主角/) as HTMLTextAreaElement;
}

describe("NovelCreatePage 表单", () => {
  beforeEach(() => {
    seen.draft = createDefaultNovelDraft();
  });

  it("梗概不到一句话时建档按钮是灰的，写够了才亮", () => {
    const submit = vi.fn();
    render(<Harness onSubmit={submit} />);
    const button = screen.getByRole("button", { name: "建档并进入设置向导" });

    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(submit).not.toHaveBeenCalled();

    fireEvent.change(premiseBox(), { target: { value: "才九个字啊" } });
    expect(button).toBeDisabled();

    fireEvent.change(premiseBox(), { target: { value: PREMISE } });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("梗概最多两千字，多的截掉", () => {
    render(<Harness />);

    fireEvent.change(premiseBox(), { target: { value: "阵".repeat(2100) } });

    expect(seen.draft.premise).toHaveLength(2000);
    expect(screen.getByText("2000/2000")).toBeInTheDocument();
  });

  it("提交中把按钮换成正在建档并禁用", () => {
    seen.draft = { ...createDefaultNovelDraft(), premise: PREMISE };
    render(<Harness isSubmitting />);

    expect(screen.getByRole("button", { name: "正在建档" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "建档并进入设置向导" })).not.toBeInTheDocument();
  });

  it("换市场分区连带把世界、结构、节奏、文风与细分主题一起推导出来", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "东方玄幻" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "女频" }));

    expect(seen.draft.market).toBe("女频");
    expect(seen.draft.subgenre).toBe("现代言情");
    expect(seen.draft.worldPreset).toBe("关系与身份秩序驱动的沉浸式世界");
    expect(seen.draft.storyStructure).toBe("人物关系变化牵引主线的长线结构");
    expect(seen.draft.pacingControl).toBe("情绪递进与关系转折交替");
    expect(seen.draft.writingStyle).toBe("细腻克制、人物感受与对话并重");
    expect(screen.getByRole("button", { name: "古代言情" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "东方玄幻" })).not.toBeInTheDocument();
  });

  it("点细分主题只改细分主题，推导出来的四条不动", () => {
    render(<Harness />);
    const derived = seen.draft.worldPreset;

    fireEvent.click(screen.getByRole("button", { name: "仙侠武侠" }));

    expect(seen.draft.subgenre).toBe("仙侠武侠");
    expect(seen.draft.market).toBe("男频");
    expect(seen.draft.worldPreset).toBe(derived);
  });

  it("选篇幅档位就把章数与每章字数写进草稿", () => {
    render(<Harness />);
    expect(seen.draft.lengthTier).toBe("standard");

    fireEvent.click(screen.getByRole("button", { name: /史诗长篇/ }));

    expect(seen.draft.lengthTier).toBe("epic");
    expect(seen.draft.chapterCount).toBe("280");
    expect(seen.draft.chapterChars).toBe("3600");
  });

  it("高级设置换掉篇幅档位，露出书名与两个数字格", () => {
    render(<Harness />);
    expect(screen.getByText("目标篇幅")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "高级设置" }));

    expect(screen.queryByText("目标篇幅")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("未命名新作")).toBeInTheDocument();
    const chapters = screen.getByLabelText("章节数");
    expect(chapters).toHaveAttribute("inputMode", "numeric");

    fireEvent.change(chapters, { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText("每章字数"), { target: { value: "2800" } });
    fireEvent.change(screen.getByPlaceholderText("未命名新作"), { target: { value: "长夜纪元" } });

    expect(seen.draft.chapterCount).toBe("42");
    expect(seen.draft.chapterChars).toBe("2800");
    expect(seen.draft.title).toBe("长夜纪元");

    fireEvent.click(screen.getByRole("button", { name: "使用篇幅档位" }));
    expect(screen.getByText("目标篇幅")).toBeInTheDocument();
  });

  it("自动推导出来的五格都能手改", () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("世界预设"), { target: { value: "只有一座城的封闭世界" } });
    fireEvent.change(screen.getByLabelText("特殊要求"), { target: { value: "每章留一个钩子" } });

    expect(seen.draft.worldPreset).toBe("只有一座城的封闭世界");
    expect(seen.draft.specialRequirements).toBe("每章留一个钩子");
    expect(screen.getByLabelText("故事结构")).toHaveValue(seen.draft.storyStructure);
    expect(screen.getByLabelText("节奏控制")).toHaveValue(seen.draft.pacingControl);
    expect(screen.getByLabelText("写作风格")).toHaveValue(seen.draft.writingStyle);
  });

  /** 上一版写在 JSX 的字符串属性里，`\n` 不是转义 —— 用户看到的是「爽点预期……\n\n例如」这几个字符。 */
  it("梗概占位文案里是真的空行", () => {
    render(<Harness />);

    expect(premiseBox().placeholder).toContain("\n\n例如：");
  });
});

/** 这四个是建档页导出的纯函数，容器建档前也在用（`hasNovelPremise` 是两边同一个门槛）。 */
describe("NovelCreatePage 导出的草稿工具", () => {
  it("缺省草稿是男频 · 东方玄幻的标准长篇", () => {
    const draft = createDefaultNovelDraft();

    expect(draft.market).toBe("男频");
    expect(draft.subgenre).toBe("东方玄幻");
    expect(draft.lengthTier).toBe("standard");
    expect(draft.chapterCount).toBe("100");
    expect(draft.chapterChars).toBe("3000");
    expect(draft.premise).toBe("");
    expect(draft.title).toBe("");
  });

  it("梗概门槛按去掉两头空白后的十个字算", () => {
    expect(hasNovelPremise({ ...createDefaultNovelDraft(), premise: "才九个字啊" })).toBe(false);
    expect(hasNovelPremise({ ...createDefaultNovelDraft(), premise: `   ${"字".repeat(9)}   ` })).toBe(false);
    expect(hasNovelPremise({ ...createDefaultNovelDraft(), premise: "字".repeat(10) })).toBe(true);
  });

  it("书名留空就从梗概第一句里截，最多十八个字", () => {
    const withPremise = (premise: string, title = ""): NovelCreateDraft => ({
      ...createDefaultNovelDraft(),
      premise,
      title,
    });

    expect(novelCreateTitle(withPremise(PREMISE, "  长夜纪元  "))).toBe("长夜纪元");
    expect(novelCreateTitle(withPremise("第一句真的开始了。第二句。"))).toBe("第一句真的开始了");
    expect(novelCreateTitle(withPremise("。！？第一句真的开始了。"))).toBe("第一句真的开始了");
    expect(novelCreateTitle(withPremise("阵".repeat(30)))).toBe("阵".repeat(18));
    expect(novelCreateTitle(withPremise("。。。"))).toBe("未命名新作");
  });

  it("题材是大类与细分主题拼起来的，细分缺了只留大类", () => {
    const draft = createDefaultNovelDraft();

    expect(novelCreateGenre(draft)).toBe("男频 · 东方玄幻");
    expect(novelCreateGenre({ ...draft, subgenre: "" })).toBe("男频");
  });
});

