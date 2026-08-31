/**
 * 素材库页面的纯逻辑：分区/筛选的取值范围、翻页累积、体积与时长文案。
 *
 * 抽出来是因为这三件事都有「说不清就会错」的边界，而 UI 里验不动：
 *  - **module → origin 的对应表是手抄的**（真身在 `apps/api/src/assets/asset-classify.ts`
 *    与 `asset-sources.ts` 的 `AUDIO_KIND_RULES`）。前端必须有这张表：键集分页下，一个
 *    module 可能到第 5 页才出现第一条，靠「已加载的素材里有哪些 module」生成筛选项的话，
 *    前几页根本给不出该有的入口。表只管**显示**，准入判定仍然只有服务端说了算。
 *  - 翻页是累积的，同一条素材不能因为「游标停在某行、该行多条素材」而出现两次（口播一行三条）。
 *  - 体积/时长服务端可能给 null（历史行没有 objectKey、图片没有时长），文案不能出现「null B」。
 */
import type { AssetItem, AssetOrigin, AssetPage, AssetSourceModule } from "./assetApi";

export interface AssetOriginTab {
  readonly origin: AssetOrigin;
  readonly label: string;
  readonly icon: string;
  /** 空态文案：两个分区的空是两回事，一个是「还没生成过」，一个是「还没上传过」。 */
  readonly emptyText: string;
}

/** 页面的两个一级分区。顺序即 Tab 顺序，默认停在第一个。 */
export const ASSET_ORIGIN_TABS: readonly AssetOriginTab[] = [
  { origin: "ai", label: "AI 生成", icon: "mdi:auto-awesome", emptyText: "还没有 AI 生成的素材，去工作流跑一次就会出现在这里。" },
  { origin: "upload", label: "我上传的", icon: "mdi:tray-arrow-up", emptyText: "还没有上传过素材。参考图、背景音乐、音色样本会归到这里。" },
];

export const ASSET_MODULE_LABELS: Readonly<Record<AssetSourceModule, string>> = {
  image: "AI 生图",
  article: "文章配图",
  ecom: "电商图",
  comic: "漫画分镜",
  reference: "参考图",
  video: "AI 视频",
  audio: "音频",
  dub: "数字人口播",
  portrait: "形象照",
  "try-on": "AI 试穿",
  "codex-pet": "桌宠",
};

/** 筛选项的展示顺序：先图、再视频音频、最后成品类。与服务端的枚举顺序无关。 */
const MODULE_ORDER: readonly AssetSourceModule[] = [
  "image",
  "portrait",
  "try-on",
  "article",
  "ecom",
  "comic",
  "reference",
  "video",
  "audio",
  "dub",
  "codex-pet",
];

/**
 * 每个 module 可能出现在哪个分区。**手抄自服务端准入规则**，改那边记得改这里：
 *  - `reference` 是 `ecom-reference:` 前缀的上传参考图 → 只在「我上传的」；
 *  - `audio` 两边都有：`narration` 是 AI 旁白，`bgm` / `voice-sample` 是用户传的；
 *  - `comic` 目前被整段拒收（漫画分镜图不进素材库），所以两个分区都不给它筛选项。
 */
const MODULE_ORIGINS: Readonly<Record<AssetSourceModule, readonly AssetOrigin[]>> = {
  image: ["ai"],
  article: ["ai"],
  ecom: ["ai"],
  comic: [],
  reference: ["upload"],
  video: ["ai"],
  audio: ["ai", "upload"],
  dub: ["ai"],
  portrait: ["ai"],
  "try-on": ["ai"],
  "codex-pet": ["ai"],
};

/** 某个分区下该给哪些 module 筛选项。 */
export function moduleFiltersForOrigin(origin: AssetOrigin): readonly AssetSourceModule[] {
  return MODULE_ORDER.filter((module) => MODULE_ORIGINS[module].includes(origin));
}

export interface AssetListState {
  readonly items: readonly AssetItem[];
  /** 下一页游标；null = 到底了，不再给「加载更多」。 */
  readonly cursor: string | null;
}

export const EMPTY_ASSET_LIST: AssetListState = { items: [], cursor: null };

/**
 * 把新一页并进已加载的列表。
 *
 * 两处防御都是真会发生的：
 *  - **按 id 去重**：同源游标是 `lte`（游标那一行要连着捞回来，因为一行可能产出多条素材），
 *    所以下一页的第一行会带回已经给过的兄弟素材；
 *  - **游标不前进就当到底**：否则「加载更多」会一直可点、每次都拿回同一批，看起来像卡死。
 */
export function appendAssetPage(state: AssetListState, page: AssetPage): AssetListState {
  const seen = new Set(state.items.map((item) => item.id));
  const fresh = page.items.filter((item) => !seen.has(item.id));
  const stalled = page.nextCursor !== null && page.nextCursor === state.cursor;
  return {
    items: fresh.length > 0 ? [...state.items, ...fresh] : state.items,
    cursor: stalled ? null : page.nextCursor,
  };
}

const SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** 体积文案。null（历史行没记 sizeBytes）返回空串，由调用方决定整块不显示。 */
export function formatAssetSize(sizeBytes: number | null): string {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes < 0) return "";
  let value = sizeBytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${SIZE_UNITS[unit]}`;
}

/** 时长文案 `m:ss` / `h:mm:ss`。图片没有时长，给 null 就返回空串。 */
export function formatAssetDuration(durationSec: number | null): string {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec < 0) return "";
  const total = Math.round(durationSec);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
