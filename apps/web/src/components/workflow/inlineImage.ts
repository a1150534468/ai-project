/**
 * 把用户选的图片文件读成「裸 base64 + mime」，给需要内联传图的工作流用（生图的参考图、桌宠的参考图）。
 *
 * 原先这个 helper 长在电商工作流的 model 文件里，电商随 Phase 1 删掉之后独立出来重写一份。
 *
 * 两个必须注意的点：
 *  - **返回的是裸 base64，不带 `data:...;base64,` 前缀**。上游接口要的是裸串，带前缀会被判成非法图片。
 *  - **mime 以 data URL 里的声明为准**，读不出来才回落到 `file.type`，最后兜底 `image/png`：
 *    有些来源（剪贴板、部分安卓相册）给的 `File.type` 是空串。
 */
export interface InlineImage {
  readonly b64: string;
  readonly mime: string;
}

const DATA_URL_MIME = /^data:([^;,]+)(?:;[^,]*)?$/;

export function readFileAsInlineImage(file: File): Promise<InlineImage> {
  return new Promise<InlineImage>((resolve, reject) => {
    const reader = new FileReader();
    const fail = () => reject(new Error("参考图读取失败"));
    reader.onerror = fail;
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") {
        fail();
        return;
      }
      const comma = dataUrl.indexOf(",");
      if (comma < 0) {
        fail();
        return;
      }
      resolve({
        b64: dataUrl.slice(comma + 1),
        mime: DATA_URL_MIME.exec(dataUrl.slice(0, comma))?.[1] || file.type || "image/png",
      });
    };
    reader.readAsDataURL(file);
  });
}
