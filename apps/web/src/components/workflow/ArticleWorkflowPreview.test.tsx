// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArticleWorkflowPreview, previewScaleWidthClass } from "./ArticleWorkflowPreview";

describe("ArticleWorkflowPreview scale", () => {
  it("maps scale to width class", () => {
    expect(previewScaleWidthClass("full")).toBe("max-w-[760px]");
    expect(previewScaleWidthClass("desktop")).toBe("max-w-[640px]");
    expect(previewScaleWidthClass("mobile")).toBe("max-w-[375px]");
  });

  it("renders three scale toggles and starts on full without the phone frame", () => {
    const { container } = render(
      <ArticleWorkflowPreview
        title="标题"
        summary=""
        previewHtml="<p>正文</p>"
        previewBodyRef={{ current: null }}
      />,
    );
    expect(screen.getByLabelText("满屏")).toBeTruthy();
    expect(screen.getByLabelText("桌面")).toBeTruthy();
    expect(screen.getByLabelText("手机")).toBeTruthy();
    expect(container.querySelector("[class*='rounded-[32px]']")).toBeNull();
  });

  it("switches to the mobile frame on click", () => {
    const { container } = render(
      <ArticleWorkflowPreview
        title="标题"
        summary=""
        previewHtml="<p>正文</p>"
        previewBodyRef={{ current: null }}
      />,
    );
    fireEvent.click(screen.getByLabelText("手机"));
    expect(container.querySelector("[class*='rounded-[32px]']")).not.toBeNull();
  });
});
