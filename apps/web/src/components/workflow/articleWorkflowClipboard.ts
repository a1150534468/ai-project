function copyTextWithTextareaFallback(text: string): boolean {
  if (!document.body) return false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  previousFocus?.focus();
  return copied;
}

function copyHtmlFromNode(node: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  const previousRanges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  const copied = document.execCommand("copy");
  selection.removeAllRanges();
  previousRanges.forEach((item) => selection.addRange(item));
  previousFocus?.focus();
  return copied;
}

async function copyHtmlWithClipboardItem(html: string, plainText: string): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
  const item = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([plainText], { type: "text/plain" }),
  });
  await navigator.clipboard.write([item]);
  return true;
}

export async function copyArticleWorkflowPlainText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (!copyTextWithTextareaFallback(text)) {
    throw new Error("clipboard_copy_failed");
  }
}

export async function copyArticleWorkflowBody(args: {
  readonly html: string;
  readonly plainText: string;
  readonly previewNode: HTMLElement | null;
}): Promise<"html" | "selection" | "plain"> {
  try {
    if (await copyHtmlWithClipboardItem(args.html, args.plainText)) return "html";
  } catch {
    // Ignore and fall through to the older copy strategies.
  }
  if (args.previewNode && copyHtmlFromNode(args.previewNode)) return "selection";
  await copyArticleWorkflowPlainText(args.plainText);
  return "plain";
}
