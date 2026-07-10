import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NovelWorkflowStudio } from "./NovelWorkflowStudio";

describe("NovelWorkflowStudio", () => {
  it("uses the project brand accent instead of a separate novel accent", () => {
    const html = renderToStaticMarkup(<NovelWorkflowStudio token="token" />);

    expect(html).not.toContain("#b8502d");
    expect(html).not.toContain("#d7a08b");
    expect(html).toContain("bg-brand");
  });

  it("renders the standalone project entry before the create form", () => {
    const html = renderToStaticMarkup(<NovelWorkflowStudio token="token" />);

    expect(html).toContain("小说作品");
    expect(html).toContain("选择作品进入编辑");
    expect(html).toContain("正在加载作品");
    expect(html).toContain("新建作品");
    expect(html).not.toContain("核心要求");
    expect(html).not.toContain("是否金手指");
    expect(html).not.toContain("每章字数");
    expect(html).not.toContain("新建当前输入");
  });

  it("does not render the roleplay stage", () => {
    const html = renderToStaticMarkup(<NovelWorkflowStudio token="token" />);

    expect(html).not.toContain("扮演");
    expect(html).not.toContain("roleplay");
  });
});
