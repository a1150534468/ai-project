import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { SpendBurst } from "./Particles";

describe("SpendBurst", () => {
  it("shows the -amount label when active", () => {
    const html = renderToStaticMarkup(<SpendBurst amount={240} originX={0} originY={0} active />);
    expect(html).toContain("-240");
  });
  it("renders nothing when inactive", () => {
    const html = renderToStaticMarkup(<SpendBurst amount={240} originX={0} originY={0} active={false} />);
    expect(html).toBe("");
  });
});
