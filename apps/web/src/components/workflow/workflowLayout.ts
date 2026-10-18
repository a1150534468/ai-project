/**
 * A 形态（左＝设置 / 中＝工作区 / 右＝历史）三区的**唯一**几何。
 *
 * 改版前四个模块各写各的栅格：生图与图文是「设置栏 + 工作区」两列通栏直角面板（三块之间靠 border
 * 分隔、没有缝），桌宠是留缝的圆角卡三列。同一个产品里「三区」长成两副样子，切模块时尺寸与边界
 * 都要重新认一遍 —— 这就是「不统一」最刺眼的地方。
 *
 * 现在统一到原型 `layout3` 那一套：**左右两栏是设置与历史、中间是工作区，缝 14px**，三块都是圆角卡
 * （原型里 `.col-set/.col-his` 是 `border + radius:16px` 的白卡），四周留出画布底色。
 * 列宽的取值见下面四条常量 —— 原型给的是 1440 下的绝对值（300 / 280），落地时按比例摊开。
 */

/**
 * 三区外壳的公共部分。**刻意不以 `grid-cols-[` 结尾** —— 为什么，见下面四条列宽常量的说明。
 *
 * 这一串三区共用，也包含窄屏的分支：窄屏是 `flex flex-col` 纵向堆叠，横排要到 `xl` 才起。
 *
 * ❗`xl:grid-rows-1` 不能少。`xl:grid` 只定了**列**，行是隐式的 `auto` —— 高度由内容说了算，
 * 三栏里最高的一栏（设置）会把这一行撑到两三千像素，三张卡跟着一起变高：工作区明明只有一张
 * 占位图，却长成跟设置栏一样高，底边还被 `overflow` 裁掉。`grid-rows-1` 落到
 * `grid-template-rows: repeat(1, minmax(0,1fr))`，行高就锁死在容器高度上，三栏各自内部滚动
 * （每栏的 body 都是 `min-h-0 flex-1 overflow-y-auto`，本来就写好了，只是过去没人约束它们）。
 * `xl:overflow-hidden` 是兜底：万一哪一栏内部漏了个不收缩的元素，宁可裁在卡里，也别把页面撑长。
 */
const WF_SHELL_BASE =
  "relative flex min-w-0 min-h-0 flex-1 flex-col gap-3.5 bg-surface-muted p-3.5 xl:grid xl:h-full xl:grid-rows-1 xl:overflow-hidden";

/**
 * 四种列组合 —— **必须各写成一条完整的类名字面量，一个字符都不能拼**。
 *
 * ❗这里踩过一个大坑：早先的写法是把 `grid-cols-[` 留在 BASE 末尾、运行时再拼列宽。Tailwind 只扫
 * 源码里的**完整字面量**，拼出来的类名它不认识 ⇒ `xl:grid` 生成了、列定义没生成 ⇒ `display:grid`
 * 生效但没有 `grid-template-columns`，栅格退化成单列 ⇒ 宽屏下三区**全部纵向堆叠**。
 * 更阴的是三层检查全都抓不到：`tsc` 不看类名、jsdom 不套 CSS、dev server 里还留着上一轮的产物，
 * 属于「离线全绿、真跑才炸」。`workflowLayout.test.ts` 现在有一条守卫盯着这件事。
 *
 * 改宽度时**四条都要改**：少改一条会有一栏宽度不对，守卫也会红。
 *
 * **两侧按百分比、带像素下限**（既不是死像素，也不是纯百分比）：
 *   - 写死 `300 / 280` 时，多出来的宽度**全归中间** —— 2560 的屏上左栏还是 300px（占 11.7%），
 *     设置被挤得读不动，中间却空着一大片；
 *   - 纯百分比在刚过 `xl`（1280）的窗口上会把设置栏压到 270 以下，字段开始折行；
 *   - `minmax(280px, 22%)` 两头都占：**1440 下 ≈298 / 278（与原型 300 / 280 差 2px 以内）**，
 *     窗口越宽两侧越宽（2200 的窗口上设置栏约 465px），窄到 1330 以下由下限兜住。
 *
 * ⚠️ 百分比是**对栅格容器的内容宽**算的，不是对视口 —— 容器的内容宽 ≈ 视口 − 84px（外壳内距与页面留白），
 * 所以 22% 在 1440 下得到的是 298 而不是 317。调比例时按 `比例 × (视口 − 84)` 估。
 */
const WF_SHELL_LR = "xl:grid-cols-[minmax(280px,22%)_minmax(0,1fr)_minmax(260px,20.5%)]";
const WF_SHELL_L = "xl:grid-cols-[minmax(280px,22%)_minmax(0,1fr)]";
const WF_SHELL_R = "xl:grid-cols-[minmax(0,1fr)_minmax(260px,20.5%)]";
const WF_SHELL_MAIN = "xl:grid-cols-[minmax(0,1fr)]";

/**
 * A 形态外壳。**没有常量版**：左右两栏的显隐由顶栏「面板开关」决定（`usePanelVisibility()`），
 * 收起的那一列连缝一起从栅格里消失、宽度归工作区，所以列数只有在运行时才知道。
 * 曾经有一个 `WF_SHELL` 常量写着三栏全展开 —— 它和这个函数就是「同一副几何的两个来源」，
 * 迟早各改各的，已删。
 */
export function wfShell(left: boolean, right: boolean): string {
  const columns = left ? (right ? WF_SHELL_LR : WF_SHELL_L) : right ? WF_SHELL_R : WF_SHELL_MAIN;
  return `${WF_SHELL_BASE} ${columns}`;
}

/**
 * B 形态（小说创建）：只有「中＝设置」与「右＝历史」两区，几何就是 A 形态收掉左栏的那一条。
 * 小说工作台自带全屏外壳，不接「面板开关」，所以这里留常量而不留函数。
 */
export const WF_SHELL_FORM = `${WF_SHELL_BASE} ${WF_SHELL_R}`;

/** 左设置 / 右历史 / 工作区共用同一副卡壳：圆角 2xl + 一条 hairline + 自成滚动容器。 */
export const WF_PANEL = "flex min-w-0 min-h-0 flex-col overflow-hidden rounded-2xl border border-hairline-subtle bg-surface";

/** 工作区的底色比两侧弱一档，让「正在产出什么」与「你要填什么 / 产出过什么」分得开。 */
export const WF_WORKSPACE = `${WF_PANEL} bg-surface-subtle`;

/**
 * 栏头：三个区（左设置 / 中工作区 / 右历史）共用的一条 56px 的头，左起点与内容对齐。
 *
 * 三个区**只有这一个**栏头常量：左栏原来另有一份 `SETTINGS_PANEL_HEAD`，两份差在 `gap` 与底色，
 * 结果是同一屏里三个区的栏头高度与间距各差一点。`bg-surface` 是给中间工作区用的 ——
 * 工作区底色是 `surface-subtle`（比两侧弱一档），栏头要显式回到白，才是「白卡的头」。
 */
export const WF_PANEL_HEAD =
  "flex min-h-14 flex-none items-center justify-between gap-3 border-b border-hairline-subtle bg-surface px-4 py-2";
