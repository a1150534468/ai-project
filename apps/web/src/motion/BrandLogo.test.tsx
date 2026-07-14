import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { BrandLogo } from "./BrandLogo";

describe("BrandLogo", () => {
  it("renders an img with alt text", () => {
    const html = renderToStaticMarkup(<BrandLogo />);
    expect(html).toContain("<img");
    expect(html).toContain("alt=\"AI 助手\"");
  });
});
