// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NovelModelSelector } from "./NovelModelSelector";

const listModels = vi.hoisted(() => vi.fn());

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  listModels,
}));

describe("NovelModelSelector", () => {
  beforeEach(() => {
    listModels.mockResolvedValue([
      { model: "preview-only", displayName: "Preview Only" },
      { model: "qwen3.7-plus", displayName: "Qwen3.7 Plus" },
    ]);
  });

  it("loads the model list and reports the selected writing model", async () => {
    const onChange = vi.fn();
    render(<NovelModelSelector value="" saving={false} onChange={onChange} />);

    const select = await screen.findByRole("combobox", { name: "写作模型" });
    expect(await screen.findByRole("option", { name: "Qwen3.7 Plus" })).toBeEnabled();
    fireEvent.change(select, { target: { value: "qwen3.7-plus" } });
    expect(onChange).toHaveBeenCalledWith("qwen3.7-plus", "Qwen3.7 Plus");
  });
});
