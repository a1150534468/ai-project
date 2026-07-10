import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { MotionRoot } from "./MotionRoot";

describe("MotionRoot", () => {
  it("renders its children", () => {
    const html = renderToStaticMarkup(
      <MotionRoot>
        <span>hello-motion</span>
      </MotionRoot>,
    );
    expect(html).toContain("hello-motion");
  });
});
