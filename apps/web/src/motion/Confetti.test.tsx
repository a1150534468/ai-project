import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { Confetti } from "./Confetti";

describe("Confetti", () => {
  it("renders no pieces when trigger is false", () => {
    const html = renderToStaticMarkup(<Confetti trigger={false} />);
    expect(html).toBe("");
  });
});
