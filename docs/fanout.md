# 爆款文案裂变（Fanout）模块

> 合并自两篇历史文档（设计文档 + 实现计划）。该模块与 `ecom`/`novel`/`report` 平级，是独立的 workflow 模块；设计定位「即用即走」，首版不落库。

## 爆款文案裂变（Fanout Copywriting）设计文档

- 日期：2026-07-07
- 模块：`fanout`（新增独立 workflow 模块，与 `ecom`/`novel`/`report` 平级）
- 定位：输入一份原始文案 → AI 结构化理解 → 沿维度批量裂变出大量不同版本 → 去重 → 复制/导出

---

### 1. 背景与目标

内容运营需要"一份原文，批量产出适配不同平台/人群/卖点/风格/情绪的大量变体，并保证彼此低重复"。
本模块把这一诉求做成平台的标准生成类 workflow，复用现有 workflow + billing + Studio 骨架。

核心洞察：用户列出的多个"裂变方向"本质是**同一操作的不同参数维度**，不是多个独立系统。
因此架构 = **一个裂变引擎 + 可插拔维度配置 + 三种生成模式**。

#### 首版覆盖的 8 个维度（归为三种模式）

| 生成模式 | 覆盖维度 | 生成逻辑 |
|---|---|---|
| **枚举模式** `enum` | 平台、卖点、人群、风格、情绪、SEO | 选 1 个维度，沿其枚举值展开 |
| **矩阵模式** `matrix` | 矩阵账号裂变 | 受控随机组合多维度 + 强制降重 |
| **脚本模式** `script` | 视频脚本裂变 | 输出结构化脚本（15s/30s/60s/口播/剧情/直播/带货） |

---

### 2. 关键决策（Brainstorming 结论）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| 1 | 首版范围 | 核心引擎 + 8 维度（5 同构 + SEO + 矩阵 + 脚本），非全 12 维 | 有"裂变感"又不拖垮工期；维度配置化，后续加维度近零成本 |
| 2 | 原文理解 | **两步式**：先结构化提取（可编辑），再裂变 | 固化一份"理解"，避免批量生成时产品定位漂移；用户可干预 |
| 3 | 批量生成粒度 | **分批并发**：拆批(每批 K 条)→限并发→汇总 | 规避 `maxOutputTokens` 截断、成本可控、部分失败可恢复 |
| 4 | 维度组合方式 | **单维度枚举为主**；矩阵作为受控组合模式，不开放笛卡尔积 | 符合 90% 用例；避免数量爆炸与 UI 复杂 |
| 5 | 降重 | **Prompt 约束 + 生成后字符级 n-gram Jaccard 过滤 + 重生** | 纯本地零计费，把"去重"从噱头变可量化真能力 |
| 6 | 模型 | 提取 + 生成默认 `MiniMax-M3`（与 `ecom-helpwrite` 一致），可配置 | 复用现有文案模型；`maxOutputTokens` 按模式分档 |
| 7 | 历史持久化 | **首版不落库**（即用即走），后续再评估 | YAGNI，最小 MVP |

---

### 3. 架构与文件划分

#### 3.1 后端（`apps/api/src/workflow/`，每文件配 `.test.ts`）

```
fanout-dimensions.ts        # 维度/枚举/prompt片段/模式maxOutputTokens 配置表（配置与逻辑分离）
fanout-types.ts             # 结构化 schema：提取结果、任务入参、变体、模式枚举
fanout-extract-service.ts   # 第1步：原文 → 结构化 {产品,受众,卖点[],风格,场景}
fanout-prompts.ts           # 三种模式 system/user prompt 构造
fanout-generate-service.ts  # 第2步：分批并发生成 + 计费 reserve/settle + 调用降重
fanout-dedup.ts             # 字符级 3-gram Jaccard 相似度 + 重生调度（纯本地）
fanout-routes.ts            # HTTP 路由：/extract /generate
```

#### 3.2 前端（`apps/web/src/components/workflow/`，沿用 EcomStudio 的 model/view 分离）

```
FanoutStudio.tsx            # 主工作台（编排）
fanoutStudioModel.ts        # 状态与业务逻辑（纯函数，可测）
fanoutStudioView.tsx        # 纯展示
workflowFanoutApi.ts        # API 客户端（apps/web/src/）
```

#### 3.3 架构原则

- **提取与生成分离**：`extract` 与 `generate` 是两个独立接口 / 两次计费，中间可编辑。
- **引擎与配置分离**：加维度只改 `fanout-dimensions.ts`，不动引擎。
- **模式即策略**：三种模式在 `fanout-generate-service` 内是三个策略函数，共享分批/计费/降重基础设施。
- 单文件 < 400 行，函数 < 50 行，公共逻辑（分批、计费封装）复用。

---

### 4. 数据流（端到端）

```
① 用户粘贴原文
        │
        ▼
② POST /fanout/extract  ──►  fanout-extract-service
        │                    原文 → 结构化 JSON（1 次调用，计费 1 笔）
        ▼
③ 前端展示结构化结果，用户可编辑（改受众 / 加卖点…）
        │
        ▼
④ 用户选模式(enum/matrix/script) + 维度 + 数量档(10/30/50/100)
   前端展示「预计消耗 X 算力点」，确认后发起
        │
        ▼
⑤ POST /fanout/generate  ──►  fanout-generate-service
        │   拆批(每批 K 条) → 并发(限流) → 每批 reserve→调用→settle
        │   matrix / enum(可选)：fanout-dedup 批内+跨批过滤，超阈值重生
        ▼
⑥ 返回变体列表（每条带 维度值 / 相似度分 / 字数），前端网格展示
        │
        ▼
⑦ 复制单条 / 批量导出文本（.txt / .md）
```

数量档位：**10 / 30 / 50 / 100** 四档，每档对应固定批次数，计费可预估。

---

### 5. 计费（金额敏感，重点）

**两类计费**：`extract` 一笔；`generate` 按批多笔。均走 `@yc/billing` 的 `reserve` / `settle`。

- **预扣**：每批生成前 `reserve` 一次，固定预扣该模式的 `maxOutputTokens`；批完成后按实际用量 `settle`。
- **幂等**：每批唯一 `operationId = fanout:{taskId}:{mode}:{batchIndex}`；重试同一批复用同一 id，`reserve` 不重复扣。
- **并发**：批次并发上限固定（如 4），信号量控制；各批 `reserve/settle` 独立，无共享可变状态。
- **一致性 / 回滚**：某批调用失败 → 该批按实际=0 结算或释放预扣，**不计费**；已成功批照常结算。采用"部分成功"语义，每批自洽，不做全局事务。
- **余额不足**：每批 `reserve` 前校验；不足则**停止后续批次**，返回"已生成 X 条 + 余额不足"，已成功批已扣费不退。
- **生成前预估**：`预计算力点 = 批次数 × 每批 maxOutputTokens 折算`，前端展示供用户确认。

模型：提取 + 生成默认 `MiniMax-M3`；`maxOutputTokens` 按模式分档（文案批小、脚本批大），集中配在 `fanout-dimensions.ts`。

---

### 6. 降重（`fanout-dedup.ts`，纯本地零计费）

- **相似度**：字符级 **3-gram Jaccard**（`|A∩B| / |A∪B|`），每条与"已接受集合"两两比对。
- **阈值**：默认 `0.7`（配置化），`> 阈值` 判重。
- **重生**：重复条触发重生，**每条最多重试 2 次**；仍超阈值则保留并标记"高相似"，不无限循环。
- **作用范围**：批内 + 跨批（维护累积"已接受集合"）。`matrix` 默认开，`enum` 提供开关，`script` 不做。
- **展示**：每条返回 `similarity` 分，前端可显示"平均相似度 XX%"。

---

### 7. 错误处理（覆盖异常路径）

| 场景 | 处理 |
|---|---|
| 提取返回非法 JSON | 重试 1 次；再失败返回可读错误，前端提示"理解失败，请精简原文重试" |
| 某批 LLM 超时 / 报错 | 该批重试 1 次；仍失败 → 跳过该批、不计费、结果标注"部分批次失败" |
| 输出截断（maxTokens） | 每批 K 条控制在安全输出量内规避；单条异常长度则丢弃重生 |
| 余额不足 | reserve 前拦截，停止后续批，返回已生成部分 |
| 原文过长 / 过短 | 边界校验：超上限截断 + 提示；过短拒绝 |

---

### 8. 测试策略（对齐平台 `.test.ts` 惯例，覆盖率对齐平台标准）

- **单元**：
  - `fanout-dimensions`：配置完整性（每维度有枚举与 prompt 片段、每模式有 maxOutputTokens）
  - `fanout-dedup`：Jaccard 边界（全同 / 全异 / 临界阈值 / 空串 / 重生上限）
  - `fanout-prompts`：三模式 prompt 构造正确
  - `fanoutStudioModel`：前端状态纯函数
- **服务**：
  - `fanout-extract-service`：mock LLM，验结构化 + 非法 JSON 重试
  - `fanout-generate-service`：mock LLM + mock billing，验分批 / 并发 / 部分失败 / 幂等 / 余额不足停止
- **路由**：`fanout-routes`：入参校验、边界、错误码

---

### 9. Out of Scope（首版明确不做，留后续）

- ❌ 配图联动（配图提示词 / AI 出图）
- ❌ 一键发布 / 定时发布（对接社媒）
- ❌ 多语言（中 / 英 / 日）
- ❌ 独立"标题裂变 / CTA 裂变 / 多长度"维度 —— 长度作为各模式**参数**（一句 / 短 / 长），标题/CTA 作为变体内**字段**，不单列为维度
- ❌ 裂变任务历史持久化（首版即用即走，不落库）
- ❌ 维度笛卡尔积交叉（B/C 组合方式）—— 留作后续"高级模式"

---

### 10. 后续可扩展方向

- 追加同构维度（标题、CTA、时间等）：仅往 `fanout-dimensions.ts` 加配置。
- 落库 + 历史侧栏（参考 `EcomHistorySidebar`）。
- 配图联动（接入现有 image workflow）。
- 多语言、一键发布、双维交叉高级模式。

## 爆款文案裂变（Fanout Copywriting）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增独立 workflow 模块 `fanout`：输入一份原文 → AI 结构化提取（可编辑）→ 沿维度分批并发裂变出 10/30/50/100 条不同文案 → 降重 → 前端网格展示与导出。

**Architecture:** 两步式（extract → generate）。extract 一次调用把原文变成结构化 JSON；generate 按数量档拆批、限并发（4）生成，每批独立 `reserve/settle` 计费、幂等靠 `operationId`；矩阵模式用字符级 3-gram Jaccard 做批内+跨批降重，不足则最多补 2 轮。三种生成模式（enum/matrix/script）在生成服务内是三个策略，共享分批/计费/降重基础设施。前端沿用 EcomStudio 的 model/view 分离，接入现有 `WORKFLOW_MODULES` + `Workflow.tsx` 渲染链。

**Tech Stack:** TypeScript, Fastify, zod, `@yc/llm`(Anthropic SDK 兼容), `@yc/billing`, Vitest, React, Tailwind。模型统一 `MiniMax-M3`。

---

### 文件结构

**后端** `apps/api/src/workflow/`（每个 `.ts` 配同名 `.test.ts`）：

| 文件 | 职责 |
|---|---|
| `fanout-types.ts` | 全模块类型：模式枚举、提取结果、生成入参、变体 |
| `fanout-dimensions.ts` | 配置表：维度枚举值、prompt 片段、各模式 batchSize/maxOutputTokens |
| `fanout-billing.ts` | 共享封装：单次 `reserve → llm.create → settle`（extract/generate 复用） |
| `fanout-dedup.ts` | 字符级 3-gram Jaccard 相似度 + 批内/跨批过滤 |
| `fanout-prompts.ts` | 三模式 system/user prompt 构造 + 变体解析 |
| `fanout-extract-service.ts` | 第 1 步：原文 → 结构化 JSON |
| `fanout-generate-service.ts` | 第 2 步：分批并发生成 + 降重编排 + 补偿 |
| `fanout-routes.ts` | `POST /api/workflow/fanout/extract`、`/generate` |

**后端接入**：`apps/api/src/server.ts` 注册路由。

**前端** `apps/web/src/`：

| 文件 | 职责 |
|---|---|
| `workflowFanoutApi.ts` | API 客户端 + 前端类型 |
| `components/workflow/fanoutStudioModel.ts` | 状态与业务纯函数（可测） |
| `components/workflow/fanoutStudioView.tsx` | 纯展示 |
| `components/workflow/FanoutStudio.tsx` | 编排 |

**前端接入**：`workflowState.ts`（模块条目 + `WorkflowModuleId`）、`pages/Workflow.tsx`（渲染分支）。

---

### Task 1: 类型与配置表

**Files:**
- Create: `apps/api/src/workflow/fanout-types.ts`
- Create: `apps/api/src/workflow/fanout-dimensions.ts`
- Test: `apps/api/src/workflow/fanout-dimensions.test.ts`

- [ ] **Step 1: 写类型文件** `fanout-types.ts`

```typescript
export type FanoutMode = "enum" | "matrix" | "script";

// 枚举模式可选的维度
export type FanoutDimensionId =
  | "platform" | "sellingPoint" | "audience" | "style" | "emotion" | "seo";

export type FanoutCount = 10 | 30 | 50 | 100;

// extract 产物：对原文的结构化理解（可被用户编辑后回传）
export interface FanoutBrief {
  readonly product: string;
  readonly audience: string;
  readonly sellingPoints: readonly string[];
  readonly style: string;
  readonly scene: string;
}

// generate 入参
export interface FanoutGenerateInput {
  readonly userId: string;
  readonly mode: FanoutMode;
  readonly brief: FanoutBrief;
  readonly count: FanoutCount;
  readonly dimension?: FanoutDimensionId; // enum 模式必填
  readonly dedup?: boolean;               // enum 模式可选；matrix 恒为 true；script 恒为 false
}

// 单条变体
export interface FanoutVariant {
  readonly id: string;
  readonly text: string;
  readonly label: string;      // 该条对应的维度值/脚本类型，如"小红书"/"60秒口播"
  readonly charCount: number;
  readonly similarity: number; // 与已接受集合的最高相似度，0~1；未去重则 0
  readonly highSimilarity: boolean;
}

export interface FanoutGenerateResult {
  readonly variants: readonly FanoutVariant[];
  readonly requested: number;      // 目标条数
  readonly delivered: number;      // 实际交付条数
  readonly avgSimilarity: number;  // 平均相似度（去重模式有意义）
  readonly partialFailure: boolean; // 是否有批次失败被跳过
  readonly stoppedByBalance: boolean; // 是否因余额不足提前停止
}
```

- [ ] **Step 2: 写配置表** `fanout-dimensions.ts`

```typescript
import type { FanoutDimensionId, FanoutMode } from "./fanout-types.js";

export const FANOUT_MODEL = "MiniMax-M3";
export const FANOUT_CONCURRENCY = 4;       // 批次并发上限
export const FANOUT_MAX_REFILL_ROUNDS = 2; // 去重不足时补批轮数上限
export const FANOUT_DEDUP_THRESHOLD = 0.7; // Jaccard 判重阈值
export const FANOUT_EXTRACT_MAX_TOKENS = 600;
export const FANOUT_TIMEOUT_MS = 60_000;
export const FANOUT_COUNTS = [10, 30, 50, 100] as const;

// 每种模式的分批参数
export interface ModeBatchConfig {
  readonly batchSize: number;      // 每批生成条数
  readonly maxOutputTokens: number; // 每批预扣/上限
}
export const MODE_BATCH: Readonly<Record<FanoutMode, ModeBatchConfig>> = {
  enum: { batchSize: 10, maxOutputTokens: 1600 },
  matrix: { batchSize: 10, maxOutputTokens: 1800 },
  script: { batchSize: 5, maxOutputTokens: 2600 },
};

// enum 模式维度定义：枚举值 + 该维度的裂变指令片段
export interface DimensionConfig {
  readonly id: FanoutDimensionId;
  readonly name: string;
  readonly values: readonly string[];   // 枚举值（如各平台名）
  readonly instruction: string;         // 注入 prompt 的裂变说明
}

export const DIMENSIONS: Readonly<Record<FanoutDimensionId, DimensionConfig>> = {
  platform: {
    id: "platform", name: "平台",
    values: ["小红书", "抖音", "视频号", "微信公众号", "知乎", "B站", "微博"],
    instruction: "为每个平台各写 1 条，贴合该平台的语气、篇幅与用户习惯。",
  },
  sellingPoint: {
    id: "sellingPoint", name: "卖点",
    values: ["效率", "成本", "速度", "质量", "智能", "专业", "安全"],
    instruction: "每条只主打一个卖点，把该卖点讲透、讲出画面感。",
  },
  audience: {
    id: "audience", name: "人群",
    values: ["学生", "教师", "HR", "销售", "老板", "行政", "产品经理", "运营"],
    instruction: "每条面向一类人群，命中其真实使用场景与痛点。",
  },
  style: {
    id: "style", name: "风格",
    values: ["正式", "口语", "故事", "悬念", "幽默", "专业", "极简", "夸张"],
    instruction: "每条用一种风格重写，风格差异要鲜明可感。",
  },
  emotion: {
    id: "emotion", name: "情绪",
    values: ["焦虑", "期待", "惊喜", "信任", "权威", "温暖", "好奇", "震惊"],
    instruction: "每条主打一种情绪，用情绪驱动点击与转化。",
  },
  seo: {
    id: "seo", name: "SEO 关键词",
    values: [], // 运行期从 brief 派生关键词，见 prompts
    instruction: "每条围绕一个搜索关键词改写，自然嵌入关键词以提升搜索覆盖。",
  },
};

export function isFanoutDimensionId(v: string): v is FanoutDimensionId {
  return v in DIMENSIONS;
}
```

- [ ] **Step 3: 写配置完整性测试** `fanout-dimensions.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { DIMENSIONS, MODE_BATCH, FANOUT_COUNTS, isFanoutDimensionId } from "./fanout-dimensions.js";

describe("fanout-dimensions", () => {
  it("每个非 SEO 维度都有枚举值和指令", () => {
    for (const [id, cfg] of Object.entries(DIMENSIONS)) {
      expect(cfg.instruction.length).toBeGreaterThan(0);
      if (id !== "seo") expect(cfg.values.length).toBeGreaterThan(0);
    }
  });
  it("每种模式都有正数 batchSize 与 maxOutputTokens", () => {
    for (const cfg of Object.values(MODE_BATCH)) {
      expect(cfg.batchSize).toBeGreaterThan(0);
      expect(cfg.maxOutputTokens).toBeGreaterThan(0);
    }
  });
  it("数量档为 10/30/50/100", () => {
    expect([...FANOUT_COUNTS]).toEqual([10, 30, 50, 100]);
  });
  it("isFanoutDimensionId 识别合法/非法", () => {
    expect(isFanoutDimensionId("platform")).toBe(true);
    expect(isFanoutDimensionId("nope")).toBe(false);
  });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @yc/api test fanout-dimensions`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/workflow/fanout-types.ts apps/api/src/workflow/fanout-dimensions.ts apps/api/src/workflow/fanout-dimensions.test.ts
git commit -m "新增 fanout 类型与维度配置表"
```

---

### Task 2: 降重算法

**Files:**
- Create: `apps/api/src/workflow/fanout-dedup.ts`
- Test: `apps/api/src/workflow/fanout-dedup.test.ts`

- [ ] **Step 1: 写失败测试** `fanout-dedup.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { jaccard3gram, filterByDedup } from "./fanout-dedup.js";

describe("jaccard3gram", () => {
  it("完全相同返回 1", () => {
    expect(jaccard3gram("一分钟做好PPT", "一分钟做好PPT")).toBe(1);
  });
  it("完全不同返回接近 0", () => {
    expect(jaccard3gram("苹果香蕉橙子葡萄", "键盘鼠标屏幕主机")).toBeLessThan(0.1);
  });
  it("空串两两为 0，不抛错", () => {
    expect(jaccard3gram("", "")).toBe(0);
    expect(jaccard3gram("abc", "")).toBe(0);
  });
  it("短于 3 字用整串比对", () => {
    expect(jaccard3gram("ab", "ab")).toBe(1);
    expect(jaccard3gram("ab", "cd")).toBe(0);
  });
});

describe("filterByDedup", () => {
  it("阈值内的重复被丢弃，返回接受项与被丢弃项", () => {
    const texts = ["一分钟做好PPT", "一分钟做好PPT", "三分钟搞定领导要的汇报稿"];
    const { accepted, dropped } = filterByDedup(texts, [], 0.7);
    expect(accepted).toEqual(["一分钟做好PPT", "三分钟搞定领导要的汇报稿"]);
    expect(dropped).toEqual([1]); // 第 2 条与第 1 条重复
  });
  it("与已接受集合(seed)跨批比对", () => {
    const { accepted, dropped } = filterByDedup(["一分钟做好PPT"], ["一分钟做好PPT"], 0.7);
    expect(accepted).toEqual([]);
    expect(dropped).toEqual([0]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @yc/api test fanout-dedup`
Expected: FAIL（模块未定义）

- [ ] **Step 3: 写实现** `fanout-dedup.ts`

```typescript
function grams(text: string): Set<string> {
  const s = text.replace(/\s+/g, "");
  const set = new Set<string>();
  if (s.length < 3) {
    if (s.length > 0) set.add(s);
    return set;
  }
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
  return set;
}

export function jaccard3gram(a: string, b: string): number {
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 返回每条与已接受集合的最高相似度
export function maxSimilarity(text: string, accepted: readonly string[]): number {
  let max = 0;
  for (const a of accepted) {
    const s = jaccard3gram(text, a);
    if (s > max) max = s;
  }
  return max;
}

export interface DedupResult {
  readonly accepted: string[];  // 新接受的文本（不含 seed）
  readonly dropped: number[];   // candidates 中被丢弃的下标
  readonly similarities: number[]; // 每个 candidate 的最高相似度（丢弃的也记录）
}

export function filterByDedup(
  candidates: readonly string[],
  seed: readonly string[],
  threshold: number,
): DedupResult {
  const pool = [...seed];
  const accepted: string[] = [];
  const dropped: number[] = [];
  const similarities: number[] = [];
  candidates.forEach((text, i) => {
    const sim = maxSimilarity(text, pool);
    similarities.push(sim);
    if (sim > threshold) {
      dropped.push(i);
    } else {
      accepted.push(text);
      pool.push(text);
    }
  });
  return { accepted, dropped, similarities };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @yc/api test fanout-dedup`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/workflow/fanout-dedup.ts apps/api/src/workflow/fanout-dedup.test.ts
git commit -m "新增 fanout 字符级 Jaccard 降重"
```

---

### Task 3: 计费+LLM 共享封装

**Files:**
- Create: `apps/api/src/workflow/fanout-billing.ts`
- Test: `apps/api/src/workflow/fanout-billing.test.ts`

复用 `ecom-helpwrite-service.ts` 的 reserve→create→settle 模式，抽成可复用单元供 extract/generate 调用。

- [ ] **Step 1: 写失败测试** `fanout-billing.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { runBillableMessage } from "./fanout-billing.js";

function fakeLlm(text: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text }],
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    },
  };
}
function fakeBilling() {
  return { reserve: vi.fn().mockResolvedValue(undefined), settle: vi.fn().mockResolvedValue(undefined) };
}

describe("runBillableMessage", () => {
  it("成功时 reserve→create→settle 并返回文本与用量", async () => {
    const llm = fakeLlm("结果文本");
    const billing = fakeBilling();
    const out = await runBillableMessage({
      operationId: "op1", userId: "u1", model: "MiniMax-M3",
      system: "sys", user: "usr", maxOutputTokens: 100, llm, billing,
    });
    expect(out.text).toBe("结果文本");
    expect(out.outputTokens).toBe(34);
    expect(billing.reserve).toHaveBeenCalledOnce();
    expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op1", outputTokens: 34 }));
  });

  it("LLM 抛错时以 0 用量结算并抛出", async () => {
    const llm = { messages: { create: vi.fn().mockRejectedValue(new Error("boom")) } };
    const billing = fakeBilling();
    await expect(runBillableMessage({
      operationId: "op2", userId: "u1", model: "MiniMax-M3",
      system: "sys", user: "usr", maxOutputTokens: 100, llm, billing,
    })).rejects.toThrow("boom");
    expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op2", outputTokens: 0 }));
  });

  it("空输出抛错", async () => {
    const llm = fakeLlm("   ");
    const billing = fakeBilling();
    await expect(runBillableMessage({
      operationId: "op3", userId: "u1", model: "MiniMax-M3",
      system: "sys", user: "usr", maxOutputTokens: 100, llm, billing,
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @yc/api test fanout-billing`
Expected: FAIL

- [ ] **Step 3: 写实现** `fanout-billing.ts`

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@yc/llm";
import { createBillingClient as makeBillingClient } from "@yc/billing";
import { FANOUT_TIMEOUT_MS } from "./fanout-dimensions.js";

export type BillingReserveSettle = Pick<ReturnType<typeof makeBillingClient>, "reserve" | "settle">;
export type LlmClientLike = {
  readonly messages: {
    readonly create: (
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number },
    ) => Promise<Anthropic.Message>;
  };
};

export function defaultBilling(): BillingReserveSettle {
  return makeBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! });
}
export function defaultLlm(): LlmClientLike {
  return createLlmClient(loadLlmConfig());
}

export function estimateInputTokens(system: string, user: string): number {
  return Math.max(1, Math.ceil(`${system}\n\n${user}`.length / 3));
}

export interface RunBillableArgs {
  readonly operationId: string;
  readonly userId: string;
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  readonly billing: BillingReserveSettle;
  readonly llm: LlmClientLike;
}
export interface RunBillableResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

// reserve → llm.create → settle。失败时以 0 用量结算并抛出（预扣被释放/不实扣）。
export async function runBillableMessage(args: RunBillableArgs): Promise<RunBillableResult> {
  const { operationId, userId, model, system, user, maxOutputTokens, billing, llm } = args;
  const estIn = estimateInputTokens(system, user);
  await billing.reserve({ operationId, userId, type: "chat", model, inputTokens: estIn, maxOutputTokens });
  try {
    const resp = await llm.messages.create(
      { model, max_tokens: maxOutputTokens, system, messages: [{ role: "user", content: user }] },
      { timeout: FANOUT_TIMEOUT_MS },
    );
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new Error("empty fanout result");
    const inputTokens = resp.usage?.input_tokens ?? estIn;
    const outputTokens = resp.usage?.output_tokens ?? 0;
    await billing.settle({ operationId, userId, model, inputTokens, outputTokens });
    return { text, inputTokens, outputTokens };
  } catch (err) {
    await billing.settle({ operationId, userId, model, inputTokens: 0, outputTokens: 0 }).catch(() => undefined);
    throw err;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @yc/api test fanout-billing`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/workflow/fanout-billing.ts apps/api/src/workflow/fanout-billing.test.ts
git commit -m "新增 fanout 计费与 LLM 调用封装"
```

---

### Task 4: Prompt 构造与变体解析

**Files:**
- Create: `apps/api/src/workflow/fanout-prompts.ts`
- Test: `apps/api/src/workflow/fanout-prompts.test.ts`

生成约定：模型输出**每行一条**（脚本模式每条用 `---` 分隔），解析时按行/分隔符切分。每批带 `labels`（该批要覆盖的维度值），prompt 要求"按给定标签逐条输出"。

- [ ] **Step 1: 写失败测试** `fanout-prompts.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { buildExtractPrompt, buildBatchPrompt, parseVariants, deriveSeoKeywords } from "./fanout-prompts.js";
import type { FanoutBrief } from "./fanout-types.js";

const brief: FanoutBrief = {
  product: "AI 办公助手，一键生成 PPT",
  audience: "职场白领",
  sellingPoints: ["效率", "自动排版"],
  style: "口语",
  scene: "临时汇报",
};

describe("buildExtractPrompt", () => {
  it("system 要求输出 JSON，user 含原文", () => {
    const { system, user } = buildExtractPrompt("我们的AI助手一键生成PPT");
    expect(system).toMatch(/JSON/);
    expect(user).toContain("一键生成PPT");
  });
});

describe("buildBatchPrompt", () => {
  it("enum/platform 批：user 含标签与维度指令", () => {
    const { system, user } = buildBatchPrompt({
      mode: "enum", dimension: "platform", brief, labels: ["小红书", "抖音"],
    });
    expect(user).toContain("小红书");
    expect(user).toContain("抖音");
    expect(system).toMatch(/每行一条|逐条/);
  });
  it("script 批：要求脚本结构与 --- 分隔", () => {
    const { system } = buildBatchPrompt({
      mode: "script", brief, labels: ["15秒短视频", "60秒口播"],
    });
    expect(system).toMatch(/---/);
  });
});

describe("parseVariants", () => {
  it("enum：按行解析并配对标签", () => {
    const v = parseVariants("enum", "小红书文案A\n抖音文案B", ["小红书", "抖音"]);
    expect(v).toEqual([
      { label: "小红书", text: "小红书文案A" },
      { label: "抖音", text: "抖音文案B" },
    ]);
  });
  it("script：按 --- 分隔解析", () => {
    const v = parseVariants("script", "脚本一\n分镜\n---\n脚本二", ["15秒", "60秒"]);
    expect(v).toHaveLength(2);
    expect(v[0].text).toContain("脚本一");
    expect(v[1].label).toBe("60秒");
  });
  it("行数多于标签时用循环标签兜底（matrix 无严格配对）", () => {
    const v = parseVariants("matrix", "a\nb\nc", ["变体"]);
    expect(v).toHaveLength(3);
    expect(v.every((x) => x.label === "变体")).toBe(true);
  });
});

describe("deriveSeoKeywords", () => {
  it("从 brief 产品名派生若干关键词种子", () => {
    const kws = deriveSeoKeywords(brief);
    expect(kws.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @yc/api test fanout-prompts`
Expected: FAIL

- [ ] **Step 3: 写实现** `fanout-prompts.ts`

```typescript
import { DIMENSIONS } from "./fanout-dimensions.js";
import type { FanoutBrief, FanoutDimensionId, FanoutMode } from "./fanout-types.js";

export function buildExtractPrompt(raw: string): { system: string; user: string } {
  const system =
    "你是资深营销策略分析师。阅读用户提供的原始文案，提取其核心信息，只输出一个 JSON 对象，" +
    '字段为：{"product":产品或服务的一句话概括,"audience":目标人群,"sellingPoints":卖点字符串数组(3~6个),"style":当前文案风格,"scene":典型使用场景}。' +
    "不要输出 JSON 以外的任何内容，不要 Markdown 代码块。";
  const user = `原始文案：\n${raw.trim()}`;
  return { system, user };
}

function briefBlock(brief: FanoutBrief): string {
  return [
    `产品：${brief.product}`,
    `人群：${brief.audience}`,
    `卖点：${brief.sellingPoints.join("、")}`,
    `原风格：${brief.style}`,
    `场景：${brief.scene}`,
  ].join("\n");
}

export function deriveSeoKeywords(brief: FanoutBrief): string[] {
  // 用产品词 + 卖点组合派生搜索关键词种子；运行期不足时由模型自行扩展
  const base = brief.product.replace(/[，,。.、].*$/, "").slice(0, 12).trim();
  const seeds = [base, `${base}工具`, `${base}软件`, `AI${base}`, `${base}推荐`];
  for (const p of brief.sellingPoints) seeds.push(`${base} ${p}`);
  return Array.from(new Set(seeds.filter((s) => s.length > 0)));
}

export interface BatchPromptArgs {
  readonly mode: FanoutMode;
  readonly brief: FanoutBrief;
  readonly labels: readonly string[]; // 该批要覆盖的维度值/脚本类型
  readonly dimension?: FanoutDimensionId; // enum 模式必填
}

export function buildBatchPrompt(args: BatchPromptArgs): { system: string; user: string } {
  const { mode, brief, labels, dimension } = args;
  if (mode === "script") {
    const system =
      "你是短视频脚本策划。根据产品信息，为每个给定的脚本类型各写一条可直接拍摄的中文脚本，" +
      "含开场钩子、核心卖点、行动号召；口播类给口播词，剧情类给分镜。" +
      "多条之间用单独一行 `---` 分隔，按给定类型顺序输出，不要编号、不要多余解释。";
    const user = `${briefBlock(brief)}\n\n脚本类型（按序各一条）：\n${labels.join("\n")}`;
    return { system, user };
  }
  if (mode === "matrix") {
    const system =
      "你是内容矩阵运营。为同一产品写出多条差异化文案，供不同账号发布。" +
      "要求每条开头、结构、用词、emoji、结尾号召都尽量不同，避免雷同被判搬运。" +
      "每行输出一条，不要编号、不要多余解释。";
    const user = `${briefBlock(brief)}\n\n请输出 ${labels.length} 条互不相同的文案。`;
    return { system, user };
  }
  // enum
  const dim = dimension ? DIMENSIONS[dimension] : undefined;
  const instruction = dim?.instruction ?? "为每个给定标签各写一条文案。";
  const system =
    "你是资深营销文案。根据产品信息，按给定标签逐条改写文案，每行输出一条，" +
    "顺序与标签一致，不要编号、不要标签前缀、不要多余解释。";
  const user = `${briefBlock(brief)}\n\n裂变要求：${instruction}\n标签（按序各一条）：\n${labels.join("\n")}`;
  return { system, user };
}

export interface ParsedVariant { readonly label: string; readonly text: string }

export function parseVariants(mode: FanoutMode, output: string, labels: readonly string[]): ParsedVariant[] {
  const chunks = mode === "script"
    ? output.split(/^\s*---\s*$/m).map((s) => s.trim()).filter((s) => s.length > 0)
    : output.split(/\r?\n/).map((s) => s.replace(/^\s*[-•\d.、)]+\s*/, "").trim()).filter((s) => s.length > 0);
  return chunks.map((text, i) => ({
    label: labels.length > 0 ? labels[i % labels.length] : "变体",
    text,
  }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @yc/api test fanout-prompts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/workflow/fanout-prompts.ts apps/api/src/workflow/fanout-prompts.test.ts
git commit -m "新增 fanout 三模式 prompt 构造与变体解析"
```

---

### Task 5: 提取服务

**Files:**
- Create: `apps/api/src/workflow/fanout-extract-service.ts`
- Test: `apps/api/src/workflow/fanout-extract-service.test.ts`

- [ ] **Step 1: 写失败测试** `fanout-extract-service.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { extractFanoutBrief } from "./fanout-extract-service.js";

function llmReturning(text: string) {
  return { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } }) } };
}
const billing = () => ({ reserve: vi.fn().mockResolvedValue(undefined), settle: vi.fn().mockResolvedValue(undefined) });
const validJson = JSON.stringify({ product: "AI助手", audience: "白领", sellingPoints: ["效率", "省钱"], style: "口语", scene: "汇报" });

describe("extractFanoutBrief", () => {
  it("解析合法 JSON 为 brief", async () => {
    const brief = await extractFanoutBrief({ userId: "u1", raw: "原文", llm: llmReturning(validJson), billing: billing() });
    expect(brief.product).toBe("AI助手");
    expect(brief.sellingPoints).toEqual(["效率", "省钱"]);
  });

  it("剥离 ```json 代码块围栏后解析", async () => {
    const wrapped = "```json\n" + validJson + "\n```";
    const brief = await extractFanoutBrief({ userId: "u1", raw: "原文", llm: llmReturning(wrapped), billing: billing() });
    expect(brief.audience).toBe("白领");
  });

  it("首次非法 JSON 时重试一次，第二次成功", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "这不是JSON" }], usage: {} })
      .mockResolvedValueOnce({ content: [{ type: "text", text: validJson }], usage: {} });
    const brief = await extractFanoutBrief({ userId: "u1", raw: "原文", llm: { messages: { create } }, billing: billing() });
    expect(create).toHaveBeenCalledTimes(2);
    expect(brief.product).toBe("AI助手");
  });

  it("空原文抛错", async () => {
    await expect(extractFanoutBrief({ userId: "u1", raw: "   ", llm: llmReturning(validJson), billing: billing() })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @yc/api test fanout-extract-service`
Expected: FAIL

- [ ] **Step 3: 写实现** `fanout-extract-service.ts`

```typescript
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FANOUT_MODEL, FANOUT_EXTRACT_MAX_TOKENS } from "./fanout-dimensions.js";
import { buildExtractPrompt } from "./fanout-prompts.js";
import {
  runBillableMessage, defaultBilling, defaultLlm,
  type BillingReserveSettle, type LlmClientLike,
} from "./fanout-billing.js";
import type { FanoutBrief } from "./fanout-types.js";

const briefSchema = z.object({
  product: z.string().trim().min(1),
  audience: z.string().trim().default(""),
  sellingPoints: z.array(z.string().trim()).default([]),
  style: z.string().trim().default(""),
  scene: z.string().trim().default(""),
});

function stripFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function tryParseBrief(text: string): FanoutBrief | null {
  try {
    const parsed = briefSchema.parse(JSON.parse(stripFence(text)));
    return { ...parsed, sellingPoints: parsed.sellingPoints };
  } catch {
    return null;
  }
}

export interface ExtractInput {
  readonly userId: string;
  readonly raw: string;
  readonly billing?: BillingReserveSettle;
  readonly llm?: LlmClientLike;
}

export async function extractFanoutBrief(input: ExtractInput): Promise<FanoutBrief> {
  const raw = input.raw.trim();
  if (!raw) throw new Error("原文不能为空");
  const { system, user } = buildExtractPrompt(raw);
  const billing = input.billing ?? defaultBilling();
  const llm = input.llm ?? defaultLlm();

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await runBillableMessage({
      operationId: `fanout-extract:${randomUUID()}`,
      userId: input.userId, model: FANOUT_MODEL,
      system, user, maxOutputTokens: FANOUT_EXTRACT_MAX_TOKENS, billing, llm,
    });
    const brief = tryParseBrief(text);
    if (brief) return brief;
  }
  throw new Error("理解失败：模型未返回合法结构");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @yc/api test fanout-extract-service`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/workflow/fanout-extract-service.ts apps/api/src/workflow/fanout-extract-service.test.ts
git commit -m "新增 fanout 原文结构化提取服务"
```

---

### Task 6: 分批并发生成服务

**Files:**
- Create: `apps/api/src/workflow/fanout-generate-service.ts`
- Test: `apps/api/src/workflow/fanout-generate-service.test.ts`

**逻辑**：
1. 按模式与 `count` 规划批次：每批带 `labels`（enum 从维度枚举值循环取；matrix 用占位标签；script 从脚本类型循环取）。
2. 并发（上限 `FANOUT_CONCURRENCY`）执行每批 `runBillableMessage`；`operationId = fanout:{taskId}:{mode}:{batchIndex}`（幂等）。
3. 单批失败：重试 1 次，仍失败则跳过并标记 `partialFailure`（不计费由 billing 封装保证）。
4. `InsufficientBalanceError`：停止后续批，标记 `stoppedByBalance`。
5. 降重（matrix 恒开、enum 看 `dedup`、script 关）：串行遍历已完成批的候选，用 `filterByDedup` 累积；不足目标则补批，最多 `FANOUT_MAX_REFILL_ROUNDS` 轮。
6. 截断到 `count` 条，计算 `avgSimilarity`。

- [ ] **Step 1: 写失败测试** `fanout-generate-service.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { generateFanout } from "./fanout-generate-service.js";
import { InsufficientBalanceError } from "@yc/billing";
import type { FanoutBrief } from "./fanout-types.js";

const brief: FanoutBrief = { product: "AI助手", audience: "白领", sellingPoints: ["效率"], style: "口语", scene: "汇报" };
const okBilling = () => ({ reserve: vi.fn().mockResolvedValue(undefined), settle: vi.fn().mockResolvedValue(undefined) });

// 每批返回 batchSize 行、彼此不同的假文案
function llmLines(prefix = "文案") {
  let n = 0;
  return { messages: { create: vi.fn().mockImplementation(async (body: any) => {
    const lines = Array.from({ length: 10 }, () => `${prefix}-${n++}-${Math.random().toString(36).slice(2, 8)}`);
    return { content: [{ type: "text", text: lines.join("\n") }], usage: { input_tokens: 5, output_tokens: 50 } };
  }) } };
}

describe("generateFanout", () => {
  it("enum 模式交付目标条数并带维度标签", async () => {
    const res = await generateFanout({
      userId: "u1", mode: "enum", dimension: "platform", brief, count: 10,
      llm: llmLines(), billing: okBilling(),
    });
    expect(res.delivered).toBe(10);
    expect(res.variants).toHaveLength(10);
    expect(res.variants[0].label).toBe("小红书");
    expect(res.variants[0].charCount).toBeGreaterThan(0);
  });

  it("某批失败(重试仍失败)时标记 partialFailure 且不整体崩溃", async () => {
    let call = 0;
    const create = vi.fn().mockImplementation(async () => {
      call++;
      if (call <= 2) throw new Error("batch boom"); // 第一批的初次+重试都失败
      const lines = Array.from({ length: 10 }, (_, i) => `ok-${call}-${i}`);
      return { content: [{ type: "text", text: lines.join("\n") }], usage: {} };
    });
    const res = await generateFanout({
      userId: "u1", mode: "enum", dimension: "platform", brief, count: 30,
      llm: { messages: { create } }, billing: okBilling(),
    });
    expect(res.partialFailure).toBe(true);
    expect(res.delivered).toBeGreaterThan(0);
  });

  it("余额不足时停止并交付已生成部分", async () => {
    let call = 0;
    const billing = {
      reserve: vi.fn().mockImplementation(async () => { call++; if (call > 1) throw new InsufficientBalanceError(); }),
      settle: vi.fn().mockResolvedValue(undefined),
    };
    const res = await generateFanout({
      userId: "u1", mode: "enum", dimension: "platform", brief, count: 30,
      llm: llmLines(), billing,
    });
    expect(res.stoppedByBalance).toBe(true);
    expect(res.delivered).toBeGreaterThan(0);
    expect(res.delivered).toBeLessThan(30);
  });

  it("matrix 模式对重复文案去重（相同输出被压到很少条）", async () => {
    // 每批都返回同样 10 行 → 去重后应远少于 count，且补批也重复 → delivered 小
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: Array.from({ length: 10 }, () => "完全一样的文案").join("\n") }],
      usage: {},
    });
    const res = await generateFanout({
      userId: "u1", mode: "matrix", brief, count: 30,
      llm: { messages: { create } }, billing: okBilling(),
    });
    expect(res.delivered).toBeLessThan(5); // 高度重复被降重
    expect(res.variants.every((v) => v.similarity <= 0.7 || res.variants.indexOf(v) === 0)).toBe(true);
  });

  it("每批 operationId 幂等且形如 fanout:{taskId}:{mode}:{i}", async () => {
    const billing = okBilling();
    await generateFanout({ userId: "u1", mode: "enum", dimension: "platform", brief, count: 10, llm: llmLines(), billing });
    const ids = billing.reserve.mock.calls.map((c) => c[0].operationId as string);
    expect(ids[0]).toMatch(/^fanout:[0-9a-f-]+:enum:0$/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @yc/api test fanout-generate-service`
Expected: FAIL

- [ ] **Step 3: 写实现** `fanout-generate-service.ts`

```typescript
import { randomUUID } from "node:crypto";
import { InsufficientBalanceError } from "@yc/billing";
import {
  FANOUT_MODEL, FANOUT_CONCURRENCY, FANOUT_MAX_REFILL_ROUNDS, FANOUT_DEDUP_THRESHOLD,
  MODE_BATCH, DIMENSIONS,
} from "./fanout-dimensions.js";
import { buildBatchPrompt, parseVariants, deriveSeoKeywords } from "./fanout-prompts.js";
import { filterByDedup, maxSimilarity } from "./fanout-dedup.js";
import {
  runBillableMessage, defaultBilling, defaultLlm,
  type BillingReserveSettle, type LlmClientLike,
} from "./fanout-billing.js";
import type { FanoutGenerateInput, FanoutGenerateResult, FanoutMode, FanoutVariant } from "./fanout-types.js";

// 该模式该 count 下，用于循环取标签的枚举池
function labelPool(mode: FanoutMode, input: FanoutGenerateInput): string[] {
  if (mode === "script") {
    return ["15秒短视频", "30秒短视频", "60秒口播", "90秒剧情", "直播话术", "带货脚本", "开场白", "结束语"];
  }
  if (mode === "matrix") return ["变体"];
  const dim = input.dimension ? DIMENSIONS[input.dimension] : DIMENSIONS.platform;
  if (dim.id === "seo") {
    const kws = deriveSeoKeywords(input.brief);
    return kws.length > 0 ? kws : [input.brief.product.slice(0, 8)];
  }
  return [...dim.values];
}

interface BatchPlan { readonly index: number; readonly labels: string[] }

function planBatches(mode: FanoutMode, count: number, pool: string[], startIndex: number): BatchPlan[] {
  const { batchSize } = MODE_BATCH[mode];
  const batches: BatchPlan[] = [];
  let produced = 0;
  let idx = startIndex;
  while (produced < count) {
    const take = Math.min(batchSize, count - produced);
    const labels: string[] = [];
    for (let i = 0; i < take; i++) labels.push(pool[(produced + i) % pool.length]);
    batches.push({ index: idx++, labels });
    produced += take;
  }
  return batches;
}

type RawVariant = { label: string; text: string };

// 并发执行一组批次，返回原始变体；遇余额不足抛出，遇批失败跳过
async function runBatches(args: {
  batches: BatchPlan[]; input: FanoutGenerateInput; taskId: string;
  billing: BillingReserveSettle; llm: LlmClientLike; onPartialFailure: () => void;
}): Promise<{ variants: RawVariant[]; balanceStopped: boolean }> {
  const { batches, input, taskId, billing, llm, onPartialFailure } = args;
  const { maxOutputTokens } = MODE_BATCH[input.mode];
  const out: RawVariant[] = [];
  let balanceStopped = false;

  for (let i = 0; i < batches.length; i += FANOUT_CONCURRENCY) {
    if (balanceStopped) break;
    const slice = batches.slice(i, i + FANOUT_CONCURRENCY);
    const settled = await Promise.all(slice.map(async (batch) => {
      const { system, user } = buildBatchPrompt({ mode: input.mode, brief: input.brief, labels: batch.labels, dimension: input.dimension });
      const operationId = `fanout:${taskId}:${input.mode}:${batch.index}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { text } = await runBillableMessage({ operationId, userId: input.userId, model: FANOUT_MODEL, system, user, maxOutputTokens, billing, llm });
          return { ok: true as const, variants: parseVariants(input.mode, text, batch.labels) };
        } catch (err) {
          if (err instanceof InsufficientBalanceError) return { ok: false as const, balance: true };
          if (attempt === 1) { onPartialFailure(); return { ok: false as const, balance: false }; }
        }
      }
      return { ok: false as const, balance: false };
    }));
    for (const r of settled) {
      if (!r.ok && r.balance) { balanceStopped = true; continue; }
      if (r.ok) out.push(...r.variants);
    }
  }
  return { variants: out, balanceStopped };
}

function dedupEnabled(input: FanoutGenerateInput): boolean {
  if (input.mode === "matrix") return true;
  if (input.mode === "script") return false;
  return input.dedup === true;
}

export interface GenerateDeps {
  readonly billing?: BillingReserveSettle;
  readonly llm?: LlmClientLike;
}

export async function generateFanout(input: FanoutGenerateInput & GenerateDeps): Promise<FanoutGenerateResult> {
  const billing = input.billing ?? defaultBilling();
  const llm = input.llm ?? defaultLlm();
  const taskId = randomUUID();
  const pool = labelPool(input.mode, input);
  const useDedup = dedupEnabled(input);

  const accepted: FanoutVariant[] = [];
  const acceptedTexts: string[] = [];
  let partialFailure = false;
  let stoppedByBalance = false;
  let nextIndex = 0;

  const addVariant = (label: string, text: string, similarity: number) => {
    accepted.push({
      id: randomUUID(), text, label,
      charCount: text.replace(/\s/g, "").length,
      similarity, highSimilarity: similarity > FANOUT_DEDUP_THRESHOLD,
    });
    acceptedTexts.push(text);
  };

  for (let round = 0; round <= FANOUT_MAX_REFILL_ROUNDS; round++) {
    const remaining = input.count - accepted.length;
    if (remaining <= 0 || stoppedByBalance) break;

    const batches = planBatches(input.mode, remaining, pool, nextIndex);
    nextIndex += batches.length;
    const { variants, balanceStopped } = await runBatches({
      batches, input, taskId, billing, llm, onPartialFailure: () => { partialFailure = true; },
    });
    if (balanceStopped) stoppedByBalance = true;

    if (!useDedup) {
      for (const v of variants) {
        if (accepted.length >= input.count) break;
        addVariant(v.label, v.text, 0);
      }
      break; // 非去重模式一轮即止（labels 已按 count 规划）
    }

    // 去重：与已接受集合比对
    const texts = variants.map((v) => v.text);
    const { accepted: freshTexts } = filterByDedup(texts, acceptedTexts, FANOUT_DEDUP_THRESHOLD);
    const freshSet = new Set(freshTexts);
    for (const v of variants) {
      if (accepted.length >= input.count) break;
      if (!freshSet.has(v.text)) continue;
      freshSet.delete(v.text); // 同一文本只收一次
      const sim = maxSimilarity(v.text, acceptedTexts);
      addVariant(v.label, v.text, sim);
    }
    if (variants.length === 0) break; // 无产出，避免空转补批
  }

  const delivered = accepted.length;
  const avgSimilarity = delivered > 0
    ? accepted.reduce((s, v) => s + v.similarity, 0) / delivered
    : 0;

  return {
    variants: accepted.slice(0, input.count),
    requested: input.count,
    delivered: Math.min(delivered, input.count),
    avgSimilarity,
    partialFailure,
    stoppedByBalance,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @yc/api test fanout-generate-service`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/workflow/fanout-generate-service.ts apps/api/src/workflow/fanout-generate-service.test.ts
git commit -m "新增 fanout 分批并发生成与降重编排"
```

---

### Task 7: 路由与注册

**Files:**
- Create: `apps/api/src/workflow/fanout-routes.ts`
- Test: `apps/api/src/workflow/fanout-routes.test.ts`
- Modify: `apps/api/src/server.ts`

参考 `ecom-helpwrite-routes.ts` 的 `authUserId` + zod + `InsufficientBalanceError` 模式。

- [ ] **Step 1: 写失败测试** `fanout-routes.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { fanoutRoutes } from "./fanout-routes.js";
import type { FanoutBrief } from "./fanout-types.js";

const brief: FanoutBrief = { product: "AI助手", audience: "白领", sellingPoints: ["效率"], style: "口语", scene: "汇报" };

function build(deps: Parameters<typeof fanoutRoutes>[1]) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { (req as { userId?: string }).userId = "u1"; });
  app.register((a) => fanoutRoutes(a, deps));
  return app;
}

describe("fanout routes", () => {
  it("POST /extract 返回 brief", async () => {
    const app = build({ extract: vi.fn().mockResolvedValue(brief) });
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/extract", payload: { raw: "我们的AI助手一键生成PPT" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.brief.product).toBe("AI助手");
  });

  it("POST /extract 空原文返回 400", async () => {
    const app = build({ extract: vi.fn() });
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/extract", payload: { raw: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("POST /generate enum 缺 dimension 返回 400", async () => {
    const app = build({ generate: vi.fn() });
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/generate", payload: { mode: "enum", brief, count: 10 } });
    expect(res.statusCode).toBe(400);
  });

  it("POST /generate 返回变体", async () => {
    const generate = vi.fn().mockResolvedValue({ variants: [{ id: "1", text: "a", label: "小红书", charCount: 1, similarity: 0, highSimilarity: false }], requested: 10, delivered: 1, avgSimilarity: 0, partialFailure: false, stoppedByBalance: false });
    const app = build({ generate });
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/generate", payload: { mode: "enum", dimension: "platform", brief, count: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.variants).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @yc/api test fanout-routes`
Expected: FAIL

- [ ] **Step 3: 写实现** `fanout-routes.ts`

```typescript
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { InsufficientBalanceError } from "@yc/billing";
import { authUserId } from "./ecom-route-helpers.js";
import { extractFanoutBrief } from "./fanout-extract-service.js";
import { generateFanout } from "./fanout-generate-service.js";
import { isFanoutDimensionId } from "./fanout-dimensions.js";
import type { FanoutBrief, FanoutGenerateInput } from "./fanout-types.js";

const extractSchema = z.object({ raw: z.string().trim().min(1).max(8000) });

const briefSchema = z.object({
  product: z.string().trim().min(1).max(500),
  audience: z.string().trim().max(200).default(""),
  sellingPoints: z.array(z.string().trim().max(120)).max(12).default([]),
  style: z.string().trim().max(120).default(""),
  scene: z.string().trim().max(200).default(""),
});

const generateSchema = z.object({
  mode: z.enum(["enum", "matrix", "script"]),
  brief: briefSchema,
  count: z.union([z.literal(10), z.literal(30), z.literal(50), z.literal(100)]),
  dimension: z.string().optional(),
  dedup: z.boolean().optional(),
}).refine((v) => v.mode !== "enum" || (v.dimension != null && isFanoutDimensionId(v.dimension)), {
  message: "enum 模式必须提供合法 dimension",
});

type FanoutDeps = {
  readonly extract?: (i: { userId: string; raw: string }) => Promise<FanoutBrief>;
  readonly generate?: (i: FanoutGenerateInput) => Promise<import("./fanout-types.js").FanoutGenerateResult>;
};

export async function fanoutRoutes(app: FastifyInstance, deps: FanoutDeps = {}) {
  const extract = deps.extract ?? extractFanoutBrief;
  const generate = deps.generate ?? generateFanout;

  app.post("/api/workflow/fanout/extract", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const parsed = extractSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const brief = await extract({ userId, raw: parsed.data.raw });
      return { success: true, data: { brief } };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "积分不足，请充值" });
      app.log.error(error);
      return reply.code(502).send({ error: "理解失败，请精简原文后重试" });
    }
  });

  app.post("/api/workflow/fanout/generate", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const result = await generate({ ...parsed.data, dimension: parsed.data.dimension as FanoutGenerateInput["dimension"], userId });
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "积分不足，请充值" });
      app.log.error(error);
      return reply.code(502).send({ error: "生成失败，请稍后重试" });
    }
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @yc/api test fanout-routes`
Expected: PASS

- [ ] **Step 5: 在 server.ts 注册路由**

Modify `apps/api/src/server.ts`：在文件顶部 import 区（紧邻 `ecom-helpwrite-routes` import 处）加：

```typescript
import { fanoutRoutes } from "./workflow/fanout-routes.js";
```

在注册区（`await app.register(ecomHelpWriteRoutes);` 之后一行）加：

```typescript
  await app.register(fanoutRoutes);
```

- [ ] **Step 6: 跑 API 构建/类型检查确认通过**

Run: `pnpm --filter @yc/api build`
Expected: 无类型错误

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/workflow/fanout-routes.ts apps/api/src/workflow/fanout-routes.test.ts apps/api/src/server.ts
git commit -m "新增 fanout 路由并在 server 注册"
```

---

### Task 8: 前端 API 客户端

**Files:**
- Create: `apps/web/src/workflowFanoutApi.ts`

参考 `workflowEcomApi.ts`：用 `ApiError, readErrorMessage`（来自 `./apiError`），`fetch` 带 `Authorization: Bearer ${token}`，POST JSON。

- [ ] **Step 1: 写客户端** `workflowFanoutApi.ts`

```typescript
import { ApiError, readErrorMessage } from "./apiError";

export type FanoutMode = "enum" | "matrix" | "script";
export type FanoutDimensionId = "platform" | "sellingPoint" | "audience" | "style" | "emotion" | "seo";
export type FanoutCount = 10 | 30 | 50 | 100;

export interface FanoutBrief {
  readonly product: string;
  readonly audience: string;
  readonly sellingPoints: readonly string[];
  readonly style: string;
  readonly scene: string;
}
export interface FanoutVariant {
  readonly id: string;
  readonly text: string;
  readonly label: string;
  readonly charCount: number;
  readonly similarity: number;
  readonly highSimilarity: boolean;
}
export interface FanoutGenerateResult {
  readonly variants: readonly FanoutVariant[];
  readonly requested: number;
  readonly delivered: number;
  readonly avgSimilarity: number;
  readonly partialFailure: boolean;
  readonly stoppedByBalance: boolean;
}

async function postJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new ApiError(resp.status, await readErrorMessage(resp));
  const json = (await resp.json()) as { data: T };
  return json.data;
}

export function extractBrief(token: string, raw: string): Promise<{ brief: FanoutBrief }> {
  return postJson("/api/workflow/fanout/extract", token, { raw });
}

export interface GenerateArgs {
  readonly mode: FanoutMode;
  readonly brief: FanoutBrief;
  readonly count: FanoutCount;
  readonly dimension?: FanoutDimensionId;
  readonly dedup?: boolean;
}
export function generateFanout(token: string, args: GenerateArgs): Promise<FanoutGenerateResult> {
  return postJson("/api/workflow/fanout/generate", token, args);
}
```

- [ ] **Step 2: 类型检查确认通过**

Run: `pnpm --filter @yc/web build`
Expected: 无类型错误（若 `apiError` 导出名不同，按现有 `workflowEcomApi.ts` 顶部 import 对齐）

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/workflowFanoutApi.ts
git commit -m "新增 fanout 前端 API 客户端"
```

---

### Task 9: 前端状态模型（纯函数）

**Files:**
- Create: `apps/web/src/components/workflow/fanoutStudioModel.ts`
- Test: `apps/web/src/components/workflow/fanoutStudioModel.test.ts`

- [ ] **Step 1: 写失败测试** `fanoutStudioModel.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  FANOUT_COUNT_OPTIONS, ENUM_DIMENSION_OPTIONS, MODE_OPTIONS,
  parseSellingPoints, formatSellingPoints, canGenerate, exportVariantsText, dedupAvailable,
} from "./fanoutStudioModel";
import type { FanoutBrief } from "../../workflowFanoutApi";

const brief: FanoutBrief = { product: "AI助手", audience: "白领", sellingPoints: ["效率"], style: "口语", scene: "汇报" };

describe("fanoutStudioModel", () => {
  it("数量档为 10/30/50/100", () => {
    expect(FANOUT_COUNT_OPTIONS.map((o) => o.value)).toEqual([10, 30, 50, 100]);
  });
  it("卖点输入解析：换行/顿号分隔去空", () => {
    expect(parseSellingPoints("效率、省钱\n 好看 ")).toEqual(["效率", "省钱", "好看"]);
    expect(formatSellingPoints(["效率", "省钱"])).toBe("效率\n省钱");
  });
  it("canGenerate：enum 需 dimension，matrix/script 不需", () => {
    expect(canGenerate({ mode: "enum", brief, dimension: undefined })).toBe(false);
    expect(canGenerate({ mode: "enum", brief, dimension: "platform" })).toBe(true);
    expect(canGenerate({ mode: "matrix", brief, dimension: undefined })).toBe(true);
    expect(canGenerate({ mode: "enum", brief: { ...brief, product: "" }, dimension: "platform" })).toBe(false);
  });
  it("dedupAvailable：仅 enum 可切换", () => {
    expect(dedupAvailable("enum")).toBe(true);
    expect(dedupAvailable("matrix")).toBe(false);
    expect(dedupAvailable("script")).toBe(false);
  });
  it("导出文本：带标签分隔", () => {
    const txt = exportVariantsText([
      { id: "1", text: "文案A", label: "小红书", charCount: 3, similarity: 0, highSimilarity: false },
      { id: "2", text: "文案B", label: "抖音", charCount: 3, similarity: 0, highSimilarity: false },
    ]);
    expect(txt).toContain("【小红书】");
    expect(txt).toContain("文案A");
    expect(txt).toContain("文案B");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @yc/web test fanoutStudioModel`
Expected: FAIL

- [ ] **Step 3: 写实现** `fanoutStudioModel.ts`

```typescript
import type { FanoutBrief, FanoutCount, FanoutDimensionId, FanoutMode, FanoutVariant } from "../../workflowFanoutApi";

export const FANOUT_COUNT_OPTIONS: readonly { value: FanoutCount; label: string }[] = [
  { value: 10, label: "10 条" }, { value: 30, label: "30 条" },
  { value: 50, label: "50 条" }, { value: 100, label: "100 条" },
];

export const MODE_OPTIONS: readonly { value: FanoutMode; label: string; hint: string }[] = [
  { value: "enum", label: "单维度裂变", hint: "沿一个维度展开，如各平台各一条" },
  { value: "matrix", label: "矩阵降重", hint: "多账号差异化，自动降低重复率" },
  { value: "script", label: "视频脚本", hint: "15/30/60秒、口播、剧情、带货" },
];

export const ENUM_DIMENSION_OPTIONS: readonly { value: FanoutDimensionId; label: string }[] = [
  { value: "platform", label: "不同平台" }, { value: "sellingPoint", label: "不同卖点" },
  { value: "audience", label: "不同人群" }, { value: "style", label: "不同风格" },
  { value: "emotion", label: "不同情绪" }, { value: "seo", label: "SEO 关键词" },
];

export function parseSellingPoints(raw: string): string[] {
  return raw.split(/[\n、,，;；]/).map((s) => s.trim()).filter((s) => s.length > 0);
}
export function formatSellingPoints(points: readonly string[]): string {
  return points.join("\n");
}

export function dedupAvailable(mode: FanoutMode): boolean {
  return mode === "enum";
}

export function canGenerate(args: { mode: FanoutMode; brief: FanoutBrief; dimension?: FanoutDimensionId }): boolean {
  if (args.brief.product.trim().length === 0) return false;
  if (args.mode === "enum" && !args.dimension) return false;
  return true;
}

export function exportVariantsText(variants: readonly FanoutVariant[]): string {
  return variants.map((v) => `【${v.label}】\n${v.text}`).join("\n\n---\n\n");
}

export function averageSimilarityLabel(avg: number): string {
  return `${Math.round(avg * 100)}%`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @yc/web test fanoutStudioModel`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/workflow/fanoutStudioModel.ts apps/web/src/components/workflow/fanoutStudioModel.test.ts
git commit -m "新增 fanout 前端状态模型纯函数"
```

---

### Task 10: 前端视图与工作台

**Files:**
- Create: `apps/web/src/components/workflow/fanoutStudioView.tsx`
- Create: `apps/web/src/components/workflow/FanoutStudio.tsx`

view 为纯展示（props 进、回调出），Studio 负责状态与调用 API。样式对齐现有 Studio 的 Tailwind class 风格（白底、圆角、`#e8e8ed` 边框系）。

- [ ] **Step 1: 写视图** `fanoutStudioView.tsx`

```tsx
import { Icon } from "@iconify/react";
import type { FanoutBrief, FanoutCount, FanoutDimensionId, FanoutMode, FanoutVariant } from "../../workflowFanoutApi";
import {
  FANOUT_COUNT_OPTIONS, MODE_OPTIONS, ENUM_DIMENSION_OPTIONS, dedupAvailable, averageSimilarityLabel,
} from "./fanoutStudioModel";

export interface FanoutStudioViewProps {
  readonly raw: string;
  readonly onRawChange: (v: string) => void;
  readonly extracting: boolean;
  readonly onExtract: () => void;
  readonly brief: FanoutBrief | null;
  readonly onBriefChange: (patch: Partial<FanoutBrief>) => void;
  readonly sellingPointsInput: string;
  readonly onSellingPointsInput: (v: string) => void;
  readonly mode: FanoutMode;
  readonly onModeChange: (m: FanoutMode) => void;
  readonly dimension?: FanoutDimensionId;
  readonly onDimensionChange: (d: FanoutDimensionId) => void;
  readonly count: FanoutCount;
  readonly onCountChange: (c: FanoutCount) => void;
  readonly dedup: boolean;
  readonly onDedupChange: (v: boolean) => void;
  readonly generating: boolean;
  readonly canGenerate: boolean;
  readonly onGenerate: () => void;
  readonly variants: readonly FanoutVariant[];
  readonly avgSimilarity: number;
  readonly delivered: number;
  readonly requested: number;
  readonly partialFailure: boolean;
  readonly stoppedByBalance: boolean;
  readonly error: string | null;
  readonly onCopy: (text: string) => void;
  readonly onExport: () => void;
}

export function FanoutStudioView(props: FanoutStudioViewProps) {
  const {
    raw, onRawChange, extracting, onExtract, brief, onBriefChange,
    sellingPointsInput, onSellingPointsInput, mode, onModeChange, dimension, onDimensionChange,
    count, onCountChange, dedup, onDedupChange, generating, canGenerate, onGenerate,
    variants, avgSimilarity, delivered, requested, partialFailure, stoppedByBalance, error, onCopy, onExport,
  } = props;

  return (
    <section className="space-y-4">
      {/* 1. 原文输入 */}
      <div className="rounded-[14px] border border-[#e8e8ed] bg-white p-5">
        <label className="mb-2 block text-sm font-semibold text-[#1d1d1f]">原始文案</label>
        <textarea
          value={raw} onChange={(e) => onRawChange(e.target.value)} rows={5}
          placeholder="粘贴一份原始文案，AI 会先理解产品/人群/卖点/风格/场景"
          className="w-full resize-y rounded-[10px] border border-[#e8e8ed] p-3 text-sm outline-none focus:border-[#0071e3]"
        />
        <button
          onClick={onExtract} disabled={extracting || raw.trim().length === 0}
          className="mt-3 inline-flex items-center gap-1 rounded-full bg-[#0071e3] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          {extracting ? <Icon icon="mdi:loading" className="animate-spin" /> : <Icon icon="mdi:magic-staff" />}
          AI 理解原文
        </button>
      </div>

      {/* 2. 可编辑 brief */}
      {brief && (
        <div className="grid gap-3 rounded-[14px] border border-[#e8e8ed] bg-white p-5 sm:grid-cols-2">
          <Field label="产品" value={brief.product} onChange={(v) => onBriefChange({ product: v })} />
          <Field label="人群" value={brief.audience} onChange={(v) => onBriefChange({ audience: v })} />
          <Field label="风格" value={brief.style} onChange={(v) => onBriefChange({ style: v })} />
          <Field label="场景" value={brief.scene} onChange={(v) => onBriefChange({ scene: v })} />
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-semibold text-[#6e6e73]">卖点（每行一个）</label>
            <textarea
              value={sellingPointsInput} onChange={(e) => onSellingPointsInput(e.target.value)} rows={3}
              className="w-full resize-y rounded-[10px] border border-[#e8e8ed] p-2 text-sm outline-none focus:border-[#0071e3]"
            />
          </div>
        </div>
      )}

      {/* 3. 裂变配置 */}
      {brief && (
        <div className="space-y-4 rounded-[14px] border border-[#e8e8ed] bg-white p-5">
          <OptionRow label="裂变模式">
            {MODE_OPTIONS.map((o) => (
              <Chip key={o.value} active={mode === o.value} onClick={() => onModeChange(o.value)} title={o.hint}>{o.label}</Chip>
            ))}
          </OptionRow>
          {mode === "enum" && (
            <OptionRow label="维度">
              {ENUM_DIMENSION_OPTIONS.map((o) => (
                <Chip key={o.value} active={dimension === o.value} onClick={() => onDimensionChange(o.value)}>{o.label}</Chip>
              ))}
            </OptionRow>
          )}
          <OptionRow label="数量">
            {FANOUT_COUNT_OPTIONS.map((o) => (
              <Chip key={o.value} active={count === o.value} onClick={() => onCountChange(o.value)}>{o.label}</Chip>
            ))}
          </OptionRow>
          {dedupAvailable(mode) && (
            <label className="flex items-center gap-2 text-sm text-[#1d1d1f]">
              <input type="checkbox" checked={dedup} onChange={(e) => onDedupChange(e.target.checked)} />
              开启降重（控制相似度）
            </label>
          )}
          <button
            onClick={onGenerate} disabled={generating || !canGenerate}
            className="inline-flex items-center gap-1 rounded-full bg-[#1d1d1f] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {generating ? <Icon icon="mdi:loading" className="animate-spin" /> : <Icon icon="mdi:shape-plus" />}
            开始裂变
          </button>
        </div>
      )}

      {error && <p className="rounded-[10px] bg-[#fff1f0] px-4 py-2 text-sm text-[#d4380d]">{error}</p>}

      {/* 4. 结果 */}
      {variants.length > 0 && (
        <div className="rounded-[14px] border border-[#e8e8ed] bg-white p-5">
          <div className="mb-3 flex items-center justify-between text-sm text-[#6e6e73]">
            <span>
              已生成 {delivered}/{requested} 条
              {avgSimilarity > 0 && <> · 平均相似度 {averageSimilarityLabel(avgSimilarity)}</>}
              {partialFailure && <span className="text-[#d4380d]"> · 部分批次失败</span>}
              {stoppedByBalance && <span className="text-[#d4380d]"> · 余额不足已停止</span>}
            </span>
            <button onClick={onExport} className="inline-flex items-center gap-1 rounded-full border border-[#e8e8ed] px-3 py-1 text-xs font-semibold">
              <Icon icon="mdi:download" /> 导出
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {variants.map((v) => (
              <div key={v.id} className="flex flex-col rounded-[10px] border border-[#e8e8ed] p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="rounded-full bg-[#f5f5f7] px-2 py-0.5 text-xs text-[#6e6e73]">{v.label}</span>
                  {v.highSimilarity && <span className="text-xs text-[#d4380d]">高相似</span>}
                </div>
                <p className="flex-1 whitespace-pre-wrap text-sm text-[#1d1d1f]">{v.text}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-[#8a8a8f]">
                  <span>{v.charCount} 字</span>
                  <button onClick={() => onCopy(v.text)} className="inline-flex items-center gap-1 hover:text-[#0071e3]">
                    <Icon icon="mdi:content-copy" /> 复制
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-[#6e6e73]">{props.label}</label>
      <input
        value={props.value} onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded-[10px] border border-[#e8e8ed] p-2 text-sm outline-none focus:border-[#0071e3]"
      />
    </div>
  );
}
function OptionRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-2 block text-xs font-semibold text-[#6e6e73]">{props.label}</span>
      <div className="flex flex-wrap gap-2">{props.children}</div>
    </div>
  );
}
function Chip(props: { active: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick} title={props.title}
      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${props.active ? "bg-[#0071e3] text-white" : "border border-[#e8e8ed] text-[#1d1d1f] hover:border-[#0071e3]"}`}
    >
      {props.children}
    </button>
  );
}
```

- [ ] **Step 2: 写工作台** `FanoutStudio.tsx`

```tsx
import { useCallback, useMemo, useState } from "react";
import { ApiError } from "../../apiError";
import * as api from "../../workflowFanoutApi";
import type { FanoutBrief, FanoutCount, FanoutDimensionId, FanoutMode, FanoutVariant } from "../../workflowFanoutApi";
import { FanoutStudioView } from "./fanoutStudioView";
import {
  parseSellingPoints, formatSellingPoints, canGenerate as canGen, exportVariantsText, dedupAvailable,
} from "./fanoutStudioModel";

export interface FanoutStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
}

export function FanoutStudio({ token, onBalanceRefresh }: FanoutStudioProps) {
  const [raw, setRaw] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [brief, setBrief] = useState<FanoutBrief | null>(null);
  const [sellingPointsInput, setSellingPointsInput] = useState("");
  const [mode, setMode] = useState<FanoutMode>("enum");
  const [dimension, setDimension] = useState<FanoutDimensionId | undefined>("platform");
  const [count, setCount] = useState<FanoutCount>(10);
  const [dedup, setDedup] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [variants, setVariants] = useState<readonly FanoutVariant[]>([]);
  const [avgSimilarity, setAvgSimilarity] = useState(0);
  const [delivered, setDelivered] = useState(0);
  const [requested, setRequested] = useState(0);
  const [partialFailure, setPartialFailure] = useState(false);
  const [stoppedByBalance, setStoppedByBalance] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveBrief = useMemo<FanoutBrief | null>(
    () => (brief ? { ...brief, sellingPoints: parseSellingPoints(sellingPointsInput) } : null),
    [brief, sellingPointsInput],
  );

  const onExtract = useCallback(async () => {
    setExtracting(true); setError(null);
    try {
      const { brief: b } = await api.extractBrief(token, raw);
      setBrief(b);
      setSellingPointsInput(formatSellingPoints(b.sellingPoints));
      onBalanceRefresh?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "理解失败，请稍后重试");
    } finally {
      setExtracting(false);
    }
  }, [token, raw, onBalanceRefresh]);

  const onGenerate = useCallback(async () => {
    if (!effectiveBrief) return;
    setGenerating(true); setError(null);
    try {
      const res = await api.generateFanout(token, {
        mode, brief: effectiveBrief, count,
        dimension: mode === "enum" ? dimension : undefined,
        dedup: dedupAvailable(mode) ? dedup : undefined,
      });
      setVariants(res.variants);
      setAvgSimilarity(res.avgSimilarity);
      setDelivered(res.delivered);
      setRequested(res.requested);
      setPartialFailure(res.partialFailure);
      setStoppedByBalance(res.stoppedByBalance);
      onBalanceRefresh?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "生成失败，请稍后重试");
    } finally {
      setGenerating(false);
    }
  }, [token, mode, effectiveBrief, count, dimension, dedup, onBalanceRefresh]);

  const onCopy = useCallback((text: string) => { void navigator.clipboard?.writeText(text); }, []);
  const onExport = useCallback(() => {
    const blob = new Blob([exportVariantsText(variants)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "fanout.txt"; a.click();
    URL.revokeObjectURL(url);
  }, [variants]);

  return (
    <FanoutStudioView
      raw={raw} onRawChange={setRaw} extracting={extracting} onExtract={onExtract}
      brief={brief} onBriefChange={(patch) => setBrief((b) => (b ? { ...b, ...patch } : b))}
      sellingPointsInput={sellingPointsInput} onSellingPointsInput={setSellingPointsInput}
      mode={mode} onModeChange={setMode} dimension={dimension} onDimensionChange={setDimension}
      count={count} onCountChange={setCount} dedup={dedup} onDedupChange={setDedup}
      generating={generating}
      canGenerate={!!effectiveBrief && canGen({ mode, brief: effectiveBrief, dimension })}
      onGenerate={onGenerate}
      variants={variants} avgSimilarity={avgSimilarity} delivered={delivered} requested={requested}
      partialFailure={partialFailure} stoppedByBalance={stoppedByBalance}
      error={error} onCopy={onCopy} onExport={onExport}
    />
  );
}
```

- [ ] **Step 3: 类型检查确认通过**

Run: `pnpm --filter @yc/web build`
Expected: 无类型错误（`ApiError` 的构造签名以现有 `apiError.ts` 为准；若不同则对齐）

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/workflow/fanoutStudioView.tsx apps/web/src/components/workflow/FanoutStudio.tsx
git commit -m "新增 fanout 前端视图与工作台"
```

---

### Task 11: 接入 workflow 模块入口

**Files:**
- Modify: `apps/web/src/workflowState.ts`（模块条目 + `WorkflowModuleId`）
- Modify: `apps/web/src/pages/Workflow.tsx`（渲染分支）

- [ ] **Step 1: 在 `workflowState.ts` 的 `WORKFLOW_MODULES` 数组加入 fanout 条目**

在 `WORKFLOW_MODULES` 数组内（如放在 `commerce-long-image` 之后）新增：

```typescript
  {
    id: "fanout",
    title: "文案裂变",
    description: "一份原文，批量裂变多平台/人群/风格/情绪版本",
    icon: "mdi:call-split",
    status: "available",
  },
```

- [ ] **Step 2: 在 `WorkflowModuleId` 联合类型加 `"fanout"`**

先定位类型定义：

Run: `grep -n "WorkflowModuleId" apps/web/src/workflowState.ts`

在其联合类型（形如 `export type WorkflowModuleId = "image" | "novel" | ...`）中加入 `| "fanout"`。

- [ ] **Step 3: 在 `Workflow.tsx` 渲染链加入 fanout 分支**

先在 import 区加：

```typescript
import { FanoutStudio } from "../components/workflow/FanoutStudio";
```

在渲染三元链中（`ComicWorkflowStudio` 分支之后、最终 `: (` 兜底之前）插入：

```tsx
        ) : activeModuleId === "fanout" ? (
          <FanoutStudio token={token} onBalanceRefresh={onBalanceRefresh} />
```

注意：`Workflow.tsx:391` 有 `activeModuleId !== "commerce-long-image"` 的通用外壳判断，fanout 会自然走通用外壳，无需改动该处。

- [ ] **Step 4: 类型检查与构建确认通过**

Run: `pnpm --filter @yc/web build`
Expected: 无类型错误

- [ ] **Step 5: 手动冒烟（可选，若本地起 web）**

进入 workflow 页 → 选"文案裂变" → 粘贴原文 → AI 理解 → 选模式/维度/数量 → 开始裂变 → 看到变体网格、可复制/导出。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/workflowState.ts apps/web/src/pages/Workflow.tsx
git commit -m "接入文案裂变模块入口与渲染"
```

---

### Self-Review 结论（编写者已核对）

**Spec 覆盖**：
- 8 维度三模式 → Task 1 配置 + Task 4 prompt + Task 6 生成 ✔
- 两步式（extract 可编辑 → generate）→ Task 5 / Task 10 ✔
- 分批并发 + 按批 reserve/settle + 幂等 operationId → Task 6 ✔
- 降重（3-gram Jaccard，matrix 默认/enum 可选/script 关，补批上限 2）→ Task 2 + Task 6 ✔
- 错误处理（非法 JSON 重试、批失败跳过、余额不足停止、边界校验）→ Task 5 / 6 / 7 ✔
- 复制 + 导出文本 → Task 10 ✔
- Out of Scope（配图/发布/多语言/落库/笛卡尔积）→ 未纳入任务 ✔

**Placeholder 扫描**：无 TBD/TODO；每个代码步骤含完整可运行代码。

**类型一致性**：`FanoutBrief`/`FanoutVariant`/`FanoutGenerateResult` 前后端字段一致；`generateFanout`、`extractFanoutBrief`、`runBillableMessage`、`filterByDedup`、`parseVariants`、`buildBatchPrompt` 签名跨任务一致。

**待实现者按现状对齐的点**（非阻塞）：
- `apiError.ts` 的导出名与 `ApiError` 构造签名以现有 `workflowEcomApi.ts` 为准。
- `WorkflowModuleId` 具体定义行由 Task 11 Step 2 的 grep 定位。
- `pnpm --filter @yc/api test <name>` 若项目用不同测试命令，按 `package.json` scripts 对齐。
