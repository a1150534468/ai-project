import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("renders content when open", () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}}><p>modal-body</p></Modal>,
    );
    expect(html).toContain("modal-body");
  });
  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      <Modal open={false} onClose={() => {}}><p>modal-body</p></Modal>,
    );
    expect(html).not.toContain("modal-body");
  });
});
