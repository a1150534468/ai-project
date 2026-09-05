/**
 * 全站唯一一处「把东西放进剪贴板」。三条路按保真度排，前一条不成就往下退：
 *
 *  1. **`ClipboardItem` 一次写 `text/html` 与 `text/plain`**：公众号编辑器认前者，纯文本
 *     输入框认后者，两边都不用二次加工；
 *  2. **选中预览里那段已经渲染好的 DOM 再 `execCommand("copy")`**：非安全上下文（http）
 *     与老 Safari 拿不到 1，选区这条路能把样式一起带走；
 *  3. **纯文本兜底**。
 *
 * 原来这套逻辑在图文工作流里（`articleWorkflowClipboard.ts`），对话页的
 * 「复制这条回复」另有一份 30 行的手写实现，三处毛病一处不落地又犯了一遍。搬到这里之后
 * 两个调用方共用同一条降级链，那份手写的删掉了。三处毛病是：
 *
 *  - **`execCommand` 先探再用**。它是废弃 API，jsdom 和部分环境根本没有这个方法，
 *    直接调 —— 抛出来的 `TypeError: document.execCommand is not a function` 会原样进 toast。
 *  - **`writeText` 被拒之后还有兜底**。那句 `await navigator.clipboard.writeText(text)`
 *    一旦被拒（文档没焦点时 Firefox / Safari 就这么干）异常直接上抛，屏幕外 textarea 那条路白站着。
 *  - **选区和焦点由一个人收拾**。textarea 那条路只还焦点不还选区：借完就走，
 *    用户手上选中的那一段没了。
 */

/** 哪条路成的。调用方靠它决定说「已复制公众号正文」还是「已复制纯文本正文」。 */
export type CopyKind = "html" | "selection" | "plain";

/** 三条路都不给写时说的话。会原样进 toast，所以写的是给人看的句子。 */
const REFUSED = "浏览器不允许写入剪贴板，请手动选中复制";

/** SSR 与非安全上下文都可能没有异步剪贴板，取一次统一判。 */
function asyncClipboard(): Clipboard | null {
  if (typeof navigator === "undefined") return null;
  return navigator.clipboard ?? null;
}

function canExecCommand(): boolean {
  return typeof document !== "undefined" && typeof document.execCommand === "function";
}

/**
 * 下面两条 `execCommand` 的路都要抢走选区与焦点，收尾必须原样还回去 ——
 * 不还的话点一次复制，光标就从编辑器里跑了，用户接着敲的字进不了原来那个框。
 *
 * 存的是 `cloneRange()` 而不是 `getRangeAt()` 拿到的那个：后者是活的，
 * 焦点一挪浏览器就把它折成一个点，等要还的时候手里剩个空选区。
 */
function stashSelection(): () => void {
  const focused = document.activeElement;
  const selection = window.getSelection();
  const held = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : [];

  return () => {
    if (selection) {
      selection.removeAllRanges();
      for (const range of held) selection.addRange(range);
    }
    if (focused instanceof HTMLElement) focused.focus();
  };
}

/** 第一条：一次写两种 MIME。缺 `ClipboardItem` 或被拒都只报「这条不成」，后面还有两条。 */
async function writeBothFormats(html: string, plainText: string): Promise<boolean> {
  const clipboard = asyncClipboard();
  if (!clipboard?.write || typeof ClipboardItem === "undefined") return false;

  const item = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([plainText], { type: "text/plain" }),
  });
  return clipboard.write([item]).then(
    () => true,
    () => false,
  );
}

/** 第二条：把预览里那段 DOM 选起来交给浏览器，样式跟着走。 */
function copyRenderedNode(node: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !canExecCommand()) return false;

  const restore = stashSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    return document.execCommand("copy");
  } finally {
    restore();
  }
}

/**
 * 第三条的下半截：借一个屏幕外的 textarea。`execCommand` 只认文档里真实存在并且被选中的元素，
 * 所以 `display:none` 不行，得挪出可视区；用完立刻收走 —— `execCommand` 自己抛了也要收。
 */
function copyViaCarrier(text: string): boolean {
  if (!canExecCommand() || !document.body) return false;

  const restore = stashSelection();
  const carrier = document.createElement("textarea");
  carrier.value = text;
  carrier.readOnly = true;
  carrier.style.cssText = "position:fixed;top:0;left:-9999px";
  document.body.append(carrier);
  try {
    carrier.focus();
    carrier.select();
    return document.execCommand("copy");
  } finally {
    carrier.remove();
    restore();
  }
}

/** 纯文本：异步 API 优先，被拒或没有都退到 textarea。只回答「进没进剪贴板」。 */
async function writePlainText(text: string): Promise<boolean> {
  const clipboard = asyncClipboard();
  if (clipboard?.writeText) {
    const written = await clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    if (written) return true;
  }
  return copyViaCarrier(text);
}

/** 标题、摘要、文案、标签、以及对话里的整条回复走这条：写不进去就抛给上层去说话。 */
export async function copyPlainText(text: string): Promise<void> {
  if (!(await writePlainText(text))) throw new Error(REFUSED);
}

/**
 * 带格式的正文走这条。三条路写成一张按顺序试的表：这一层的规则就是「谁先成算谁」，
 * 让代码长得像那句话，比三段各自 return 的 if 少一处漏改。
 */
export async function copyRichText(args: {
  readonly html: string;
  readonly plainText: string;
  readonly previewNode: HTMLElement | null;
}): Promise<CopyKind> {
  const tiers: readonly {
    readonly kind: CopyKind;
    readonly attempt: () => boolean | Promise<boolean>;
  }[] = [
    { kind: "html", attempt: () => writeBothFormats(args.html, args.plainText) },
    { kind: "selection", attempt: () => (args.previewNode ? copyRenderedNode(args.previewNode) : false) },
    { kind: "plain", attempt: () => writePlainText(args.plainText) },
  ];

  for (const tier of tiers) {
    if (await tier.attempt()) return tier.kind;
  }
  throw new Error(REFUSED);
}
