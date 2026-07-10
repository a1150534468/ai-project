import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { Stagger, StaggerItem } from "./Stagger";

describe("Stagger", () => {
  it("renders all items", () => {
    const html = renderToStaticMarkup(
      <Stagger>
        <StaggerItem><span>row-1</span></StaggerItem>
        <StaggerItem><span>row-2</span></StaggerItem>
      </Stagger>,
    );
    expect(html).toContain("row-1");
    expect(html).toContain("row-2");
  });
});
