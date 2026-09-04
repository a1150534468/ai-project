import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotionRoot } from "./MotionRoot";

describe("MotionRoot", () => {
  // 它只是 MotionConfig 的一层壳：自己不产生任何 DOM，子树必须原样出来
  it("原样渲染子树，不额外包元素", () => {
    const html = renderToStaticMarkup(
      <MotionRoot>
        <span>hello-motion</span>
      </MotionRoot>,
    );

    expect(html).toBe("<span>hello-motion</span>");
  });
});
