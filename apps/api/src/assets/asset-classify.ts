/**
 * `ImageAsset.requestId` 前缀 → 素材库准入裁定。
 *
 * 为什么必须有这张表：`ImageAsset` 一张表里同时装着裸生图成品、电商主图、电商拼图、
 * 电商参考图、文章配图、漫画分镜。**按表收就等于换个容器堆同一堆东西**（计划第二部分），
 * 所以准入必须按「形态 × 来源 × 角色」三个维度逐条裁，而 requestId 前缀是唯一能区分它们的信号。
 *
 * 前缀的权威出处（全仓 7 个 `imageAsset.create/upsert` 调用点逐个追出来的）：
 *   - `comic:`          comic-production-helpers.ts:142
 *   - `article:`        article-workflow-images.ts:51
 *   - `ecom-reference:` **两处**：image-routes.ts:214 与 ecom-routes.ts:361
 *   - `ecom-stitch:`    ecom-routes.ts:500
 *   - `ecom-master:`    ecom-routes.ts:238（operationPrefix）
 *   - `ecom-segment:`   ecom-routes.ts:295
 *   - `ecom-main:`      ecom-main-routes.ts:248
 *   - 其余             image-task-runner.ts:99，requestId 由前端给（实测有 `req-` / `img-` / `pet-`）
 *
 * 两条与计划正文不同、需要复核的地方：
 *
 * 1. **计划写「前缀 `ecom-` 一律不进」，这里只排除 `ecom-stitch:` 和未知的 `ecom-*`。**
 *    `ecom-master:` / `ecom-segment:` / `ecom-main:` 按计划自己的三维规则是**交付成品**，
 *    不是中间件；`listRecentImages` 排掉整个 `ecom-` 前缀是因为电商工作台另有视图，
 *    对应计划规则 3 的「素材库最多做引用」—— 所以按 `article:` 同样的办法处理：进，
 *    但带 `groupKey`（workflow/job id）让前端折叠到所属项目下。
 * 2. **`ecom-reference:` 进「我上传的」区，而不是被 `ecom-` 一起排掉。** 它是用户上传的
 *    参考图（计划「用户上传的输入素材」一节，M2），素材库天然该同时装上传和生成。
 *    它的 sourceModule 记作 `reference` 而不是 `ecom`：这个前缀被 image 和 ecom 两个模块
 *    共用，从前缀恢复不出真正的工作流，硬填一个等于编造出处。
 *
 * 未知 `ecom-*` 默认**不进**：宁可漏一个成品，也不要把中间件漏进用户的素材库。
 */

import type { Prisma } from "@prisma/client";
import type { AssetOrigin, AssetSourceModule } from "./asset-types.js";

export interface ImagePrefixRule {
  readonly prefix: string;
  readonly admit: boolean;
  readonly sourceModule: AssetSourceModule;
  readonly origin: AssetOrigin;
  /** 归属项目 id 在 requestId 里的位置（`:` 分段下标）；没有则 null。 */
  readonly groupSegment: number | null;
  readonly why: string;
}

/** 顺序敏感：先具体后兜底，`ecom-stitch:` 必须排在 `ecom-` 之前。 */
export const IMAGE_PREFIX_RULES: readonly ImagePrefixRule[] = [
  {
    prefix: "comic:",
    admit: false,
    sourceModule: "comic",
    origin: "ai",
    groupSegment: null,
    why: "漫画分镜是中间件，漫画 episode 的资产 tab 才是它的家（计划规则 3）",
  },
  {
    prefix: "article:",
    admit: true,
    sourceModule: "article",
    origin: "ai",
    groupSegment: 1,
    why: "文章配图：是媒体、可单独取用，但主入口应是文章项目，故折叠到项目下",
  },
  {
    prefix: "ecom-reference:",
    admit: true,
    sourceModule: "reference",
    origin: "upload",
    groupSegment: null,
    why: "用户上传的参考图，不是 AI 产物；归「我上传的」区（M2）",
  },
  {
    prefix: "ecom-stitch:",
    admit: false,
    sourceModule: "ecom",
    origin: "ai",
    groupSegment: null,
    why: "电商拼图是中间件",
  },
  {
    prefix: "ecom-master:",
    admit: true,
    sourceModule: "ecom",
    origin: "ai",
    groupSegment: 1,
    why: "电商主图成品，折叠到所属 workflow 下",
  },
  {
    prefix: "ecom-segment:",
    admit: true,
    sourceModule: "ecom",
    origin: "ai",
    groupSegment: 1,
    why: "电商分段图成品，折叠到所属 workflow 下",
  },
  {
    prefix: "ecom-main:",
    admit: true,
    sourceModule: "ecom",
    origin: "ai",
    groupSegment: 1,
    why: "电商主图 job 成品，折叠到所属 job 下",
  },
  {
    prefix: "ecom-",
    admit: false,
    sourceModule: "ecom",
    origin: "ai",
    groupSegment: null,
    why: "未知的 ecom 前缀按中间件处理：漏一个成品胜过把中间件塞进素材库",
  },
];

/** 兜底：前端自己给的 requestId（实测 `req-` / `img-` / `pet-`），就是裸生图成品。 */
export const DEFAULT_IMAGE_RULE: ImagePrefixRule = {
  prefix: "",
  admit: true,
  sourceModule: "image",
  origin: "ai",
  groupSegment: null,
  why: "裸生图成品：当前除了最新 50 条 strip 无处可找，素材库正是要填这个空缺",
};

export function classifyImageRequestId(requestId: string): ImagePrefixRule {
  return IMAGE_PREFIX_RULES.find((rule) => requestId.startsWith(rule.prefix)) ?? DEFAULT_IMAGE_RULE;
}

/**
 * 规则表 → Prisma where。**准入必须在 SQL 里裁完，不能拉回内存再筛。**
 *
 * 原因在分页上：多路归并靠「某个源返回的行数没填满窗口 ⇒ 该源见底」来判断到底了没有。
 * 内存里再筛掉几条，这个判断就不成立了 —— 筛掉多少条，就有多少条本该露面的素材被顶出
 * 窗口，于是既漏行、又可能提前收尾。
 *
 * 翻法：**「首个命中的规则」= 各准入规则的「命中我、且我前面的规则都没命中」之或**，
 * 再加上兜底规则的「一条都没命中」。这样翻出来的 LIKE 比手工化简的多，但它是从表机械
 * 推出来的 —— 以后往表里插一条规则，不用重新推导 SQL。
 */
export function imageAdmissionWhere(filter?: {
  readonly sourceModule?: AssetSourceModule | null;
  readonly origin?: AssetOrigin | null;
}): Prisma.ImageAssetWhereInput {
  const wanted = (rule: ImagePrefixRule) =>
    (!filter?.sourceModule || rule.sourceModule === filter.sourceModule)
    && (!filter?.origin || rule.origin === filter.origin);
  const branches: Prisma.ImageAssetWhereInput[] = [];
  IMAGE_PREFIX_RULES.forEach((rule, index) => {
    if (!rule.admit || !wanted(rule)) return;
    branches.push(firstMatchOnly(rule.prefix, IMAGE_PREFIX_RULES.slice(0, index)));
  });
  if (wanted(DEFAULT_IMAGE_RULE)) branches.push(noRuleMatches());
  // 空 OR 在 Prisma 里就是「一行都不要」，正是过滤条件谁都不满足时该有的答案。
  return { OR: branches };
}

function firstMatchOnly(prefix: string, earlier: readonly ImagePrefixRule[]): Prisma.ImageAssetWhereInput {
  if (earlier.length === 0) return { requestId: { startsWith: prefix } };
  return {
    AND: [
      { requestId: { startsWith: prefix } },
      ...earlier.map((rule) => ({ NOT: { requestId: { startsWith: rule.prefix } } })),
    ],
  };
}

function noRuleMatches(): Prisma.ImageAssetWhereInput {
  return { AND: IMAGE_PREFIX_RULES.map((rule) => ({ NOT: { requestId: { startsWith: rule.prefix } } })) };
}

/** 按规则取归属项目 id。取不到（段数不够/为空）时返回 null，不返回空串。 */
export function imageGroupKey(requestId: string, rule: ImagePrefixRule): string | null {
  if (rule.groupSegment === null) return null;
  return requestId.split(":")[rule.groupSegment]?.trim() || null;
}
