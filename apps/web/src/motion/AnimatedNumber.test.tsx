import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { AnimatedNumber } from "./AnimatedNumber";

describe("AnimatedNumber", () => {
  it("renders the formatted target value in server markup", () => {
    const html = renderToStaticMarkup(<AnimatedNumber value={12480} />);
    expect(html).toContain("12,480");
  });
});
