import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let echartsCache: string | null = null;
let gsapCache: string | null = null;

/** lazy 读取内联库源，模块级缓存，避免每份报告重复读盘。 */
function loadEcharts(): string {
  if (echartsCache === null) {
    echartsCache = readFileSync(require.resolve("echarts/dist/echarts.min.js"), "utf8");
  }
  return echartsCache;
}
function loadGsap(): string {
  if (gsapCache === null) {
    gsapCache = readFileSync(require.resolve("gsap/dist/gsap.min.js"), "utf8");
  }
  return gsapCache;
}

/** 基础 reset/排版 + 动画工具类（模型可直接用这些 class 做灵动动效）。 */
export const BASE_CSS = `
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#0f172a;background:#f8fafc;line-height:1.6;padding:24px}
h1,h2,h3{color:#0f172a;margin:0.6em 0 0.4em}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2e8f0;padding:8px 12px;text-align:left}
th{background:#f0fdfa;color:#0d9488}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.reveal{animation:fadeUp .6s ease both}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.rpt-toc{position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;margin:-24px -24px 24px;background:rgba(248,250,252,.94);backdrop-filter:blur(8px);border-bottom:1px solid #e2e8f0}
.rpt-toc-link{font-size:13px;color:#0d9488;text-decoration:none;padding:4px 12px;border:1px solid #99f6e4;border-radius:999px;background:#f0fdfa;white-space:nowrap}
.rpt-toc-link:hover{background:#0d9488;color:#fff}
.rpt-section{scroll-margin-top:64px;margin-bottom:8px}
`;

/**
 * 安全网：加载后强制显示仍被摁成透明的内容，兜住「模型用 gsap/ScrollTrigger 等把元素
 * 设成 opacity:0 却没成功 reveal」导致的整页空白（如引用了未内联的 ScrollTrigger 插件）。
 * 只补救仍不可见的元素，不干扰已正常播放完的入场动画。
 */
export const SAFETY_SCRIPT = `(function(){function fix(){try{var seen=document.querySelectorAll('.reveal');seen.forEach(function(el){var o=parseFloat(getComputedStyle(el).opacity);if(isNaN(o)||o<0.99){el.style.setProperty('opacity','1','important');el.style.setProperty('transform','none','important');el.style.setProperty('animation','none','important');el.style.setProperty('visibility','visible','important');}});document.querySelectorAll('[style]').forEach(function(el){if(el.style.opacity!==''&&parseFloat(el.style.opacity)<0.99){el.style.setProperty('opacity','1','important');el.style.setProperty('transform','none','important');}});}catch(e){}}function schedule(){setTimeout(fix,1200);setTimeout(fix,2500);}if(document.readyState==='complete'){schedule();}else{window.addEventListener('load',schedule);}document.addEventListener('DOMContentLoaded',schedule);})();`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 分块模式下把各段 HTML 拼成带顶部目录导航(锚点跳转)的长报告 body。
 * TOC 链接文字(来自分表名)做转义；段内容(模型 HTML)原样注入。
 */
export function assembleSectionedBody(
  sections: ReadonlyArray<{ title: string; html: string }>,
): string {
  // 目录去碎片：把「ROI报表 (1/9)…(9/9)」这类同表分段在目录里合并为一个入口(指向首段)。
  const tocLinks: string[] = [];
  let lastBase = "";
  sections.forEach((s, i) => {
    const base = s.title.replace(/\s*\(\d+\/\d+\)\s*$/, "");
    if (base !== lastBase) {
      tocLinks.push(`<a href="#rpt-sec-${i + 1}" class="rpt-toc-link">${escapeHtml(base)}</a>`);
      lastBase = base;
    }
  });
  const body = sections
    .map((s, i) => `<section id="rpt-sec-${i + 1}" class="rpt-section reveal">${s.html}</section>`)
    .join("");
  return `<nav class="rpt-toc">${tocLinks.join("")}</nav>${body}`;
}

export interface ShellLibs {
  readonly echarts?: string;
  readonly gsap?: string;
}

/**
 * 把模型产出的报告 HTML body 包成自包含单文件文档。
 * body 一字不改；ECharts/GSAP/基础CSS 由外壳内联，保证离线可开。
 */
export function wrapReportHtml(body: string, libs: ShellLibs = {}): string {
  const echarts = libs.echarts ?? loadEcharts();
  const gsap = libs.gsap ?? loadGsap();
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>可视化报告</title><style>${BASE_CSS}</style><script>${echarts}</script><script>${gsap}</script><script>${SAFETY_SCRIPT}</script></head><body>${body}</body></html>`;
}
