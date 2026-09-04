// @vitest-environment jsdom

/**
 * 上传区。三处要钉住：文件夹那个 input 挂载时就带上两个非标准属性（原来靠一个挂在
 * 「当前库」上的 effect 碰巧补设）、`pickerKey` 一变两个 input 就重挂（这是清空已选文件的
 * 唯一手段）、以及失败超过 5 条时多出来的那些有话说（原来一声不响地截断）。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocumentUploader from "./DocumentUploader";

function file(name: string): File {
  return new File(["hi"], name);
}

function mount(overrides: Partial<Parameters<typeof DocumentUploader>[0]> = {}) {
  const onChoose = vi.fn();
  const onUpload = vi.fn();
  const view = render(
    <DocumentUploader
      files={[]}
      uploaded={0}
      failures={[]}
      uploading={false}
      pickerKey={0}
      onChoose={onChoose}
      onUpload={onUpload}
      {...overrides}
    />,
  );

  const inputs = () => Array.from(view.container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  return { onChoose, onUpload, inputs, rerender: view.rerender };
}

describe("两个选择器由一张表生成", () => {
  it("文件那个带 accept，文件夹那个带 webkitdirectory / directory", () => {
    const { inputs } = mount();
    const [picker, folder] = inputs();

    expect(screen.getByText("批量选择文件")).toBeInTheDocument();
    expect(screen.getByText("一次选择文件夹")).toBeInTheDocument();

    expect(picker?.getAttribute("accept")).toContain(".pdf");
    expect(picker?.hasAttribute("webkitdirectory")).toBe(false);

    // 属性在 ref 回调里随挂载一起设好，不再等某个 effect
    expect(folder?.hasAttribute("webkitdirectory")).toBe(true);
    expect(folder?.hasAttribute("directory")).toBe(true);
    expect(folder?.hasAttribute("accept")).toBe(false);
  });

  it("pickerKey 一变两个 input 就换成新节点 —— 清空已选文件靠的就是这个", () => {
    const { inputs, rerender, onChoose, onUpload } = mount();
    const before = inputs();

    rerender(
      <DocumentUploader
        files={[]}
        uploaded={0}
        failures={[]}
        uploading={false}
        pickerKey={1}
        onChoose={onChoose}
        onUpload={onUpload}
      />,
    );

    const after = inputs();
    expect(after).toHaveLength(2);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    // 重挂之后文件夹那个属性还在（ref 回调跟着新节点又跑了一次）
    expect(after[1]?.hasAttribute("webkitdirectory")).toBe(true);
  });

  it("挑完把 FileList 整个交回去", () => {
    const { inputs, onChoose } = mount();
    const picker = inputs()[0] as HTMLInputElement;

    fireEvent.change(picker, { target: { files: [file("a.md")] } });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose.mock.calls[0]?.[0]).toHaveLength(1);
  });
});

describe("已选与失败都只露前 5 条", () => {
  it("多于 5 个文件就报剩下几个", () => {
    mount({ files: ["a", "b", "c", "d", "e", "f", "g"].map(file) });

    expect(screen.getByText("已选择 7 个文件")).toBeInTheDocument();
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.queryByText("f")).toBeNull();
    expect(screen.getByText("还有 2 个文件")).toBeInTheDocument();
  });

  it("失败多于 5 条也报剩下几条 —— 原来这里截到 5 就没了", () => {
    mount({ failures: ["1: 坏", "2: 坏", "3: 坏", "4: 坏", "5: 坏", "6: 坏"] });

    expect(screen.getByRole("alert")).toHaveTextContent("失败 6 个");
    expect(screen.getByText("还有 1 个失败未列出")).toBeInTheDocument();
  });

  it("没选也没失败时这两块都不画", () => {
    mount();

    expect(screen.queryByText(/已选择/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("上传键", () => {
  it("一个文件都没选就点不动", () => {
    const { onUpload } = mount();

    const button = screen.getByRole("button", { name: "上传并向量化" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("选了就能点", () => {
    const { onUpload } = mount({ files: [file("a.md")] });

    fireEvent.click(screen.getByRole("button", { name: "上传并向量化" }));
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("上传中换成进度文案，并把两个选择器一起锁住", () => {
    const { inputs } = mount({ files: [file("a.md"), file("b.md")], uploading: true, uploaded: 1 });

    expect(screen.getByRole("button", { name: "上传中 1/2" })).toBeDisabled();
    for (const input of inputs()) expect(input).toBeDisabled();
  });
});
