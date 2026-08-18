import MarkdownIt, { type Token } from "markdown-it";
// @ts-expect-error markdown-it-mark 无类型声明（==高亮== 插件）
import markdownItMark from "markdown-it-mark";
import { buildStyles, type BuildStylesOpts, type MdWechatTheme } from "./themes.js";
import type { ArticleWorkflowGalleryMode } from "./types.js";

/** 画廊布局模式：拼贴 / 网格 / 单列。 */
export type GalleryMode = ArticleWorkflowGalleryMode;

const GAP = 0.012;

function normalizeGalleryMode(mode: string | undefined): GalleryMode {
  return mode === "grid" || mode === "stack" || mode === "collage" ? mode : "collage";
}

function escapeHtmlAttr(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 读取 token 的字符串属性（attrGet 返回 string | number | null，统一归一为字符串）。 */
function attrStr(token: Token, name: string): string {
  return String(token.attrGet(name) ?? "");
}

/** 图片宽高比：v1 不量取真实比例，统一按 4:3 估算。 */
function aspectOf(_src: string): number {
  return 4 / 3;
}

/** 对齐式画廊的宽度分配，返回每张图宽度百分比；null 表示「右列裁切填充」槽位。 */
function justifiedWidths(mode: GalleryMode, count: number, aspects: number[]): (number | null)[] {
  const row = (idxs: number[]): number[] => {
    const sum = idxs.reduce((s, j) => s + aspects[j]!, 0);
    const scale = 1 - GAP * (idxs.length - 1);
    return idxs.map((j) => Math.round((aspects[j]! / sum) * scale * 10000) / 100);
  };
  const all = [...Array(count).keys()];
  if (mode === "grid") {
    const w3 = Math.round(((100 - GAP * 100 * 2) / 3) * 100) / 100;
    const w2 = Math.round(((100 - GAP * 100) / 2) * 100) / 100;
    const rows: number[] = [];
    if (count === 2 || count === 4) {
      rows.push(2);
      if (count === 4) rows.push(2);
    } else {
      for (let rest = count; rest > 0; rest -= 3) rows.push(Math.min(3, rest));
    }
    const widths: number[] = [];
    for (const n of rows) {
      const w = n === 3 ? w3 : n === 2 ? w2 : 100;
      for (let i = 0; i < n; i += 1) widths.push(w);
    }
    return widths;
  }
  if (count === 2) return row(all);
  if (count === 3) {
    const [a0, a1, a2] = aspects;
    const S = 1 / a1! + 1 / a2! + GAP;
    const x = (a0! * (1 - GAP) * S) / (1 + a0! * S);
    return [Math.round(Math.min(0.68, Math.max(0.5, x)) * 10000) / 100, null, null];
  }
  if (count === 4) return [null, ...row([1, 2, 3])];
  const [a0, a1, a2] = aspects;
  const S = 1 / a1! + 1 / a2! + GAP;
  const x = (a0! * (1 - GAP) * S) / (1 + a0! * S);
  const out: (number | null)[] = [Math.round(Math.min(0.68, Math.max(0.5, x)) * 10000) / 100, null, null];
  const rest = all.slice(3);
  const perRow = rest.length === 3 ? 3 : 2;
  for (let s = 0; s < rest.length; s += perRow) out.push(...row(rest.slice(s, s + perRow)));
  return out;
}

/** 焦点区右列两图的裁切比例（宽:高），使右列总高恒等于左图高、底边齐平。 */
function rightColumnRatio(leftW: number, a0: number): string | null {
  const leftH = leftW / a0;
  const rightW = 100 - GAP * 100 - leftW;
  const itemH = (leftH - GAP * 100) / 2;
  if (!(rightW > 5) || !(itemH > 5)) return null;
  return `${Math.round(rightW * 100) / 100}:${Math.round(itemH * 100) / 100}`;
}

export interface RenderOpts extends BuildStylesOpts {
  readonly galleryMode?: GalleryMode;
}

interface RendererResult {
  render: (src: string) => string;
  styles: Record<string, string>;
}

function createRenderer(theme: MdWechatTheme, opts: RenderOpts): RendererResult {
  const styles = buildStyles(theme, opts);
  const galleryMode = normalizeGalleryMode(opts.galleryMode);
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  md.use(markdownItMark);
  const esc = md.utils.escapeHtml;

  const dl = (token: Token): string => (token.map ? ` data-line="${token.map[0]}"` : "");

  // ---- 图库排版：连续图片自动拼成并排 / 网格布局 ----
  md.core.ruler.push("gallery", (state) => {
    const t = state.tokens;
    const isSingleImgPara = (i: number): boolean =>
      t[i]?.type === "paragraph_open" &&
      t[i + 1]?.type === "inline" &&
      t[i + 1]?.children?.length === 1 &&
      t[i + 1]?.children?.[0]?.type === "image" &&
      t[i + 2]?.type === "paragraph_close";
    const galleryInlineCount = (i: number): number => {
      if (t[i]?.type !== "paragraph_open" || t[i + 1]?.type !== "inline" || t[i + 2]?.type !== "paragraph_close")
        return 0;
      const c = t[i + 1]?.children ?? [];
      const imgs = c.filter((x) => x.type === "image");
      return imgs.length >= 2 && c.every((x) => x.type === "image" || x.type === "softbreak") ? imgs.length : 0;
    };

    for (let i = 0; i < t.length; i += 1) {
      if (isSingleImgPara(i)) {
        let count = 0;
        while (isSingleImgPara(i + count * 3)) count += 1;
        if (count < 2) continue;
        const srcs: string[] = [];
        for (let k = 0; k < count; k += 1) srcs.push(attrStr(t[i + k * 3 + 1]!.children![0]!, "src"));
        const widths = justifiedWidths(galleryMode, count, srcs.map(aspectOf));
        for (let k = 0; k < count; k += 1) {
          const base = i + k * 3;
          t[base]!.attrSet("data-g", `${count}:${k}`);
          t[base + 2]!.attrSet("data-gc", `${count}:${k}`);
          t[base + 1]!.children![0]!.attrSet("data-gi", `plain:${count}:${k}`);
          t[base + 1]!.children![0]!.attrSet("data-gw", widths[k] == null ? "" : String(widths[k]));
          if ((count === 3 || count >= 5) && (k === 1 || k === 2)) {
            const gr = rightColumnRatio(widths[0] as number, aspectOf(srcs[0]!));
            if (gr) t[base + 1]!.children![0]!.attrSet("data-gr", gr);
          }
        }
        i += count * 3 - 1;
      } else {
        const count = galleryInlineCount(i);
        if (!count) continue;
        t[i]!.attrSet("data-g", `${count}:wrap`);
        t[i + 2]!.attrSet("data-gc", "wrap");
        const imgChildren = (t[i + 1]?.children ?? []).filter((x) => x.type === "image");
        const widths = justifiedWidths(
          galleryMode,
          count,
          imgChildren.map((x) => aspectOf(attrStr(x, "src"))),
        );
        let k = 0;
        for (const x of t[i + 1]?.children ?? []) {
          if (x.type === "image") {
            x.attrSet("data-gi", `${count}:${k}`);
            x.attrSet("data-gw", widths[k] == null ? "" : String(widths[k]));
            if ((count === 3 || count >= 5) && (k === 1 || k === 2)) {
              const gr = rightColumnRatio(widths[0] as number, aspectOf(attrStr(imgChildren[0]!, "src")));
              if (gr) x.attrSet("data-gr", gr);
            }
            k += 1;
          } else if (x.type === "softbreak") {
            x.attrSet("data-gskip", "1");
          }
        }
      }
    }
  });

  // 需要「索引式章节号」的主题把 H2 开头的数字独立成视觉组件
  if (theme.extractH2Index) {
    md.core.ruler.push("section_index", (state) => {
      for (let i = 0; i < state.tokens.length - 1; i += 1) {
        const open = state.tokens[i]!;
        const inline = state.tokens[i + 1];
        if (open.type !== "heading_open" || open.tag !== "h2" || inline?.type !== "inline") continue;
        const firstText = inline.children?.find((child) => child.type === "text" && child.content.trim());
        if (!firstText) continue;
        const match = firstText.content.match(/^(\d{1,2})[.、]?\s+(.+)$/);
        if (!match) continue;
        open.meta = { ...(open.meta || {}), sectionIndex: match[1]!.padStart(2, "0") };
        firstText.content = match[2]!;
      }
    });
  }

  // 为段落记录真实的块级祖先（列表项 / 引用块），供段落样式区分
  md.core.ruler.push("block_context", (state) => {
    const stack: string[] = [];
    for (const token of state.tokens) {
      if (token.nesting === -1) stack.pop();
      if (token.type === "paragraph_open") {
        const nearest = [...stack].reverse().find((type) => type === "list_item_open" || type === "blockquote_open");
        token.meta = {
          ...(token.meta || {}),
          blockContext: nearest === "list_item_open" ? "list" : nearest === "blockquote_open" ? "blockquote" : "normal",
        };
      }
      if (token.type === "blockquote_open") {
        token.meta = {
          ...(token.meta || {}),
          blockquoteDepth: stack.filter((type) => type === "blockquote_open").length,
        };
      }
      if (token.nesting === 1) stack.push(token.type);
    }
  });

  const galleryContainer = (token: Token, count: number): string => {
    let layout = "display:block;";
    if (galleryMode === "grid") layout = "display:flex;flex-wrap:wrap;justify-content:space-between;";
    if (galleryMode === "collage" && (count === 2 || count === 3)) layout = "display:flex;";
    return `<section${dl(token)} data-gallery-mode="${galleryMode}" style="${escapeHtmlAttr(`${layout}${styles.gallery}`)}">`;
  };

  const galleryItemParts = (count: number, i: number, gw: string): { open: string; close: string; image: string } => {
    if (galleryMode === "stack") {
      return {
        open: `<section style="margin:0 0 ${i === count - 1 ? "0" : "8px"};">`,
        close: "</section>",
        image: "height:auto;box-sizing:border-box;",
      };
    }
    if (galleryMode === "grid") {
      const width = gw ? `${gw}%` : count === 2 || count === 4 ? "49.4%" : count === 1 ? "100%" : "32.53%";
      return {
        open: `<section style="width:${width};margin-bottom:1.2%;">`,
        close: "</section>",
        image: "aspect-ratio:1/1;object-fit:cover;height:auto;box-sizing:border-box;",
      };
    }
    if (count === 2) {
      return {
        open: i === 0 ? `<section style="width:${gw || 61}%;margin-right:1.2%;">` : '<section style="flex:1;">',
        close: "</section>",
        image: "height:auto;box-sizing:border-box;",
      };
    }
    if (count === 3) {
      if (i === 0) {
        return {
          open: `<section style="width:${gw || 62}%;margin-right:1.2%;">`,
          close: "</section>",
          image: "height:auto;box-sizing:border-box;",
        };
      }
      return {
        open:
          i === 1
            ? '<section style="flex:1;display:flex;flex-direction:column;"><section style="margin-bottom:1.2%;">'
            : "<section>",
        close: i === 2 ? "</section></section>" : "</section>",
        image: "height:auto;box-sizing:border-box;",
      };
    }
    if (count === 4) {
      if (i === 0) {
        return {
          open: '<section style="margin-bottom:1.2%;">',
          close: "</section>",
          image: "height:auto;box-sizing:border-box;",
        };
      }
      return {
        open:
          i === 1
            ? `<section style="display:flex;justify-content:space-between;"><section style="width:${gw || 32}%;">`
            : `<section style="width:${gw || 32}%;">`,
        close: i === 3 ? "</section></section>" : "</section>",
        image: "height:auto;box-sizing:border-box;",
      };
    }
    if (i === 0) {
      return {
        open: `<section style="display:flex;margin-bottom:1.2%;"><section style="width:${gw || 62}%;margin-right:1.2%;">`,
        close: "</section>",
        image: "height:auto;box-sizing:border-box;",
      };
    }
    if (i === 1 || i === 2) {
      return {
        open:
          i === 1
            ? '<section style="flex:1;display:flex;flex-direction:column;"><section style="margin-bottom:1.2%;">'
            : "<section>",
        close: i === 2 ? "</section></section></section>" : "</section>",
        image: "height:auto;box-sizing:border-box;",
      };
    }
    const remaining = count - 3;
    const fallbackWidth = remaining === 3 ? "32%" : "49%";
    return {
      open:
        i === 3
          ? `<section style="display:flex;flex-wrap:wrap;justify-content:space-between;"><section style="width:${gw || fallbackWidth};margin-bottom:1.2%;">`
          : `<section style="width:${gw || fallbackWidth};margin-bottom:1.2%;">`,
      close: i === count - 1 ? "</section></section>" : "</section>",
      image: "height:auto;box-sizing:border-box;",
    };
  };

  const codeStyle =
    "font-family:Menlo,Consolas,'Courier New',monospace;font-size:13px;line-height:1.7;text-align:left;color:#abb2bf;white-space:pre;";
  const wrapCode = (inner: string, token: Token): string => {
    const frameStyle = styles.pre || "background-color:#282c34;border-radius:10px;margin:1.2em 8px;overflow:hidden;";
    const bodyStyle = styles.preBody || "padding:16px;overflow-x:auto;";
    const lines = inner
      .split("\n")
      .map((line) => `<code style="${escapeHtmlAttr(`${codeStyle}display:block;`)}">${line || "&nbsp;"}</code>`)
      .join("");
    return `<section${dl(token)} style="${escapeHtmlAttr(`${frameStyle}${bodyStyle}`)}">${lines}</section>`;
  };

  md.renderer.rules.paragraph_open = (tokens, idx) => {
    if (tokens[idx]!.hidden) return "";
    const g = attrStr(tokens[idx]!, "data-g");
    if (g) {
      const [countStr, pos] = g.split(":");
      const count = Number(countStr);
      if (pos === "wrap") return galleryContainer(tokens[idx]!, count);
      const i = Number(pos);
      const gw = attrStr(tokens[idx + 1]?.children?.[0] ?? tokens[idx]!, "data-gw");
      return `${i === 0 ? galleryContainer(tokens[idx]!, count) : ""}${galleryItemParts(count, i, gw).open}`;
    }
    const context = tokens[idx]!.meta?.blockContext as string | undefined;
    if (context === "list") return `<p${dl(tokens[idx]!)} style="${escapeHtmlAttr(styles.liP)}">`;
    if (context === "blockquote") return `<p${dl(tokens[idx]!)} style="${escapeHtmlAttr(styles.bqP)}">`;
    return `<p${dl(tokens[idx]!)} style="${escapeHtmlAttr(styles.p)}">`;
  };

  md.renderer.rules.paragraph_close = (tokens, idx) => {
    if (tokens[idx]!.hidden) return "";
    const g = attrStr(tokens[idx]!, "data-gc");
    if (g) {
      if (g === "wrap") return "</section>";
      const [countStr, pos] = g.split(":");
      const count = Number(countStr);
      const i = Number(pos);
      return `${galleryItemParts(count, i, "").close}${i === count - 1 ? "</section>" : ""}`;
    }
    return "</p>\n";
  };

  md.renderer.rules.softbreak = (tokens, idx) => (tokens[idx]!.attrGet("data-gskip") ? "" : "<br>");

  md.renderer.rules.heading_open = (tokens, idx) => {
    const level = Number(tokens[idx]!.tag.slice(1));
    const style =
      (
        { 1: styles.h1, 2: styles.h2, 3: styles.h3, 4: styles.h4, 5: styles.h5, 6: styles.h6 } as Record<number, string>
      )[level] || styles.h4;
    const wrap = styles[`h${level}WrapOpen`] || "";
    const sectionIndex = tokens[idx]!.meta?.sectionIndex as string | undefined;
    const indexHtml =
      level === 2 && sectionIndex && styles.h2Index
        ? `<span aria-hidden="true" style="${escapeHtmlAttr(styles.h2Index)}">${esc(sectionIndex)}</span>`
        : "";
    return `<h${level}${dl(tokens[idx]!)} style="${escapeHtmlAttr(style)}">${indexHtml}${wrap}`;
  };
  md.renderer.rules.heading_close = (tokens, idx) => {
    const level = Number(tokens[idx]!.tag.slice(1));
    const wrap = styles[`h${level}WrapClose`] || "";
    return `${wrap}</h${level}>`;
  };

  md.renderer.rules.blockquote_open = (tokens, idx) => {
    const style = (tokens[idx]!.meta?.blockquoteDepth as number | undefined)
      ? styles.blockquoteNested
      : styles.blockquote;
    return `<blockquote${dl(tokens[idx]!)} style="${escapeHtmlAttr(style)}">`;
  };
  md.renderer.rules.bullet_list_open = (tokens, idx) => `<ul${dl(tokens[idx]!)} style="${escapeHtmlAttr(styles.ul)}">`;
  md.renderer.rules.ordered_list_open = (tokens, idx) => {
    const start = attrStr(tokens[idx]!, "start");
    const startAttr = start ? ` start="${escapeHtmlAttr(start)}"` : "";
    return `<ol${dl(tokens[idx]!)}${startAttr} style="${escapeHtmlAttr(styles.ol)}">`;
  };
  md.renderer.rules.list_item_open = () => `<li style="${escapeHtmlAttr(styles.li)}">`;
  md.renderer.rules.strong_open = () => `<strong style="${escapeHtmlAttr(styles.strong)}">`;
  md.renderer.rules.mark_open = () => `<mark style="${escapeHtmlAttr(styles.mark)}">`;
  if (styles.em) md.renderer.rules.em_open = () => `<em style="${escapeHtmlAttr(styles.em)}">`;
  if (styles.s) md.renderer.rules.s_open = () => `<s style="${escapeHtmlAttr(styles.s)}">`;
  md.renderer.rules.hr = (tokens, idx) => {
    if (styles.hrHtml) return styles.hrHtml.replace(">", `${dl(tokens[idx]!)}>`);
    return `<hr${dl(tokens[idx]!)} style="${escapeHtmlAttr(styles.hr)}"/>`;
  };

  md.renderer.rules.link_open = (tokens, idx) => {
    const title = attrStr(tokens[idx]!, "title");
    const titleAttr = title ? ` title="${escapeHtmlAttr(title)}"` : "";
    return `<a href="${esc(attrStr(tokens[idx]!, "href"))}"${titleAttr} style="${escapeHtmlAttr(styles.a)}">`;
  };

  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx]!;
    const src = esc(attrStr(token, "src"));
    const alt = token.content || "";
    const title = attrStr(token, "title");
    const titleAttr = title ? ` title="${escapeHtmlAttr(title)}"` : "";
    const gi = attrStr(token, "data-gi");
    const gw = attrStr(token, "data-gw");
    const gr = attrStr(token, "data-gr");
    const grStyle = gr ? `aspect-ratio:${escapeHtmlAttr(gr)};object-fit:cover;` : "";
    if (gi.startsWith("plain:")) {
      const [, countStr, pos] = gi.split(":");
      const parts = galleryItemParts(Number(countStr), Number(pos), gw);
      return `<img${dl(token)} src="${src}" alt="${esc(alt)}"${titleAttr} decoding="async" style="${escapeHtmlAttr(`${styles.galleryImg}${parts.image}${grStyle}`)}"/>`;
    }
    if (gi) {
      const [count, i] = gi.split(":").map(Number);
      const parts = galleryItemParts(count!, i!, gw);
      return `${parts.open}<img src="${src}" alt="${esc(alt)}"${titleAttr} decoding="async" style="${escapeHtmlAttr(`${styles.galleryImg}${parts.image}${grStyle}`)}"/>${parts.close}`;
    }
    const imgTag = `<img${dl(token)} src="${src}" alt="${esc(alt)}"${titleAttr} decoding="async" style="${escapeHtmlAttr(styles.img)}"/>`;
    if (!alt.trim()) return imgTag;
    return `${imgTag}<span style="${escapeHtmlAttr(styles.caption)}">${esc(alt)}</span>`;
  };

  md.renderer.rules.table_open = (tokens, idx) =>
    `<section${dl(tokens[idx]!)} style="${escapeHtmlAttr(styles.tableWrap)}"><table style="${escapeHtmlAttr(styles.table)}">`;
  md.renderer.rules.table_close = () => "</table></section>";
  md.renderer.rules.th_open = (tokens, idx) => {
    const align = attrStr(tokens[idx]!, "style");
    return `<th style="${escapeHtmlAttr(`${styles.th}${align}`)}">`;
  };
  md.renderer.rules.td_open = (tokens, idx) => {
    const align = attrStr(tokens[idx]!, "style");
    return `<td style="${escapeHtmlAttr(`${styles.td}${align}`)}">`;
  };

  md.renderer.rules.code_inline = (tokens, idx) =>
    `<code style="${escapeHtmlAttr(styles.code)}">${esc(tokens[idx]!.content)}</code>`;
  md.renderer.rules.code_block = (tokens, idx) => wrapCode(esc(tokens[idx]!.content), tokens[idx]!);
  md.renderer.rules.fence = (tokens, idx) => wrapCode(esc(tokens[idx]!.content), tokens[idx]!);

  return { render: (src: string) => md.render(src), styles };
}

/** 用确定性主题把 Markdown 渲染成公众号可粘贴的内联 CSS HTML 片段。 */
export function renderArticleWorkflowHtml(markdown: string, theme: MdWechatTheme, opts: RenderOpts = {}): string {
  const { render, styles } = createRenderer(theme, opts);
  return `<section style="${escapeHtmlAttr(styles.container)}">${render(markdown)}</section>`;
}

/**
 * 图片注入用的最小形态：只有槽位与落库稳定地址。
 *
 * 为什么不在共享包里依赖 ArticleWorkflowImageAsset：确定性渲染只关心「哪张图、放哪」，
 * assetId/thumbnailUrl/caption/prompt 都与排版无关。前端本地换肤（阶段 5）也会用同一份
 * imageManifest 的 imageUrl，保持签名前稳定地址即可。
 */
export interface ArticleWorkflowImageMarkdownSource {
  readonly slot: string;
  readonly imageUrl: string;
}

/** 把 url 用尖括号包起来，防止空格/括号破坏 markdown 图片语法；顺带清掉尖括号本身。 */
function markdownSafeImageUrl(url: string): string {
  const cleaned = url.replace(/[<>]/g, "");
  return cleaned.includes(" ") || cleaned.includes("(") || cleaned.includes(")") ? `<${cleaned}>` : cleaned;
}

/**
 * 把正文 Markdown 与配图清单合成「渲染器可直接消费」的 Markdown。
 *
 * 图片是独立 imageManifest + 生成后才有的 URL，正文 Markdown 里本没有图片语法。
 * 这里按封面在前、正文居中、内页图连续排在末尾的方式注入：
 * - 封面单图不与其他图相邻，渲染器按普通单图处理；
 * - 内页图连续段落会命中渲染器的画廊 core rule，自动拼成拼贴/网格/单列布局。
 *
 * 图片统一用空 alt（`![]`），这样 Markdown 可见文字与渲染出的 HTML 可见文字都不含图注，
 * 保证确定性渲染在「可见文字完全一致」的硬闸下零回归。
 */
export function articleWorkflowMarkdownWithImages(
  bodyMarkdown: string,
  images: readonly ArticleWorkflowImageMarkdownSource[],
): string {
  const withUrl = images.filter((image) => image.imageUrl.trim());
  const cover = withUrl.filter((image) => image.slot === "cover");
  const inline = withUrl.filter((image) => image.slot !== "cover");

  const parts: string[] = [];
  for (const image of cover) parts.push(`![](${markdownSafeImageUrl(image.imageUrl.trim())})`);
  const body = bodyMarkdown.trim();
  if (body) parts.push(body);
  for (const image of inline) parts.push(`![](${markdownSafeImageUrl(image.imageUrl.trim())})`);
  return parts.join("\n\n");
}
