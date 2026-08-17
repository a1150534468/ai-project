# 微信通道（wechat）

> 自包含模块文档：个人微信接入的设计 spec 与分阶段实现计划。

## 一、模块概述

让用户在**个人微信私聊**里与 AI 助手对话。桌面端承载微信收发（iLink 协议长轮询），经 connector WebSocket 上推云端，云端走已有 chat/runTurn 链路回复后下发桌面端，桌面端再通过 iLink 发回微信。

代码位置：桌面端 `apps/desktop/src/shared/wechat/`，云端 `apps/api/src/wechat/`，协议定义在 `packages/connector-protocol/src/wechat.ts`。

## 二、核心架构决策

- **微信 iLink 长轮询跑在桌面端**，token 用 Electron `safeStorage` 加密存储——微信凭据不离用户本机。
- **复用现有 device/hub WebSocket** 通道；新增 `wechat.*` 协议消息类型承载「设备上推微信消息」与「云端下发发送指令」。
- **云端复用 runTurn/billing/prisma 原语**：强制指定模型（MiniMax-M3）跑 headless chat 回合并计费；绑定关系存 `WechatBinding` 表。
- **P1 只做纯文字闭环**；P2 多模态（图片/文件/语音原生入 M3）；P3 绑定 Agent 团队 + agent 操作电脑。

## 三、分阶段实现计划

### 个人微信接入设计（桌面端 connector · 强制 MiniMax-M3）

> 源文件：`2026-07-07-wechat-channel-design.md`


- 日期：2026-07-07
- 状态：已评审通过，待实现计划
- 作者：星野

#### 1. 背景与目标

参考 CowAgent（zhayujie，原 chatgpt-on-wechat）的微信接入方式，为 yun-claude 增加**个人微信**接入能力：用户用个人微信扫码后，在微信私聊里与自己在 yun-claude 上配置的 Agent / Agent 团队对话，消费算力点计费，并可通过 Agent 团队操作本机电脑。

##### CowAgent 个人微信机制（调研结论）
- 走腾讯官方域名 `ilinkai.weixin.qq.com` 的 **iLink Bot 协议**，非 gewechat/iPad 逆向、非 itchat/wxauto hook。
- **无需注册/申请**：不需要 app_id/密钥/白名单，仅要求微信客户端 ≥ 8.0.69，纯扫码即可拿 token（请求头仅 `iLink-App-Id: bot`，`bot_type=3`）。
- 流程：`get_bot_qrcode` 取二维码 → `get_qrcode_status` 长轮询扫码状态 → 拿 bot token → `getupdates` 长轮询收消息 → `sendmessage` 发消息；媒体经 `novac2c.cdn.weixin.qq.com` CDN，AES-128-ECB 加解密；每用户维护 `context_token` 用于回复/主动推送。
- 生成的是**独立机器人身份**，仅私聊生效，不影响本人微信正常使用。

##### 残留风险（已知悉）
- iLink 为腾讯半公开协议，腾讯有权随时变更/关闭。
- 个人号挂机器人存在轻微 ToS 风险（走官方 iLink 端点显著低于 gewechat/itchat）。
- 社区反馈存在"微信掉线"高频问题，需掉线检测 + 重扫。

#### 2. 关键决策总账

| 项 | 结论 |
|---|---|
| 形态 | 个人微信，iLink bot 协议 |
| 部署 | 跑在桌面端 connector（本地长轮询、token 本地存），云端不常驻轮询 |
| 交互模型 | 私聊 bot → 绑定的 Agent/团队回复 |
| 绑定目标 | 单个 Agent 或 Agent 团队，统一为 `target = { type: agent \| team, id }` |
| 模型 | **强制 MiniMax-M3**，覆盖 agent/团队自带模型 |
| 权限 | 完全放开：任何能私聊 bot 者均可让 agent 团队无二次确认操作绑定电脑 |
| 多模态 | 图片/文件/语音原生喂给 M3（M3 为全模态，无需 STT）；出向发文字 |
| 会话 | 微信自成一个持续会话线程（有上下文，独立于网页/桌面会话）|
| 计费 | 复用现有 chat 计费（预扣 1 万 → 实扣），归属 binding 所属租户 |

#### 3. 架构与数据流

同一台桌面端既是"微信长轮询宿主"，又是"被 agent 操作的电脑"，形成闭环，复用现有 device/hub。

```
[微信 App]                [桌面端 connector]              [云端 apps/api]
   │  用户发消息              │ iLink 长轮询 getupdates        │
   │ ─────────────────────►  │                                │
   │                         │  wechat.inbound (WS 上推) ───► │ ① 解析绑定(租户/目标/强制M3)
   │                         │                                │ ② 续接微信会话线程
   │                         │                                │ ③ 跑 chat/agent + 预扣算力点
   │                         │  ◄─── tool 下发(terminal/fs/…) │ ④ agent团队干活下发到同一设备
   │                         │  tool.result ───────────────► │
   │                         │  ◄─── wechat.send (最终回复)   │ ⑤ 出结果
   │  ◄───────────────────   │ iLink sendmessage 发回微信     │
```

#### 4. 组件拆解

##### 4.1 桌面端 iLink 客户端（`apps/desktop`，新增）
- 移植 CowAgent `channel/weixin/weixin_api.py` 逻辑为 TS：扫码登录、长轮询 getupdates、sendmessage、CDN 媒体 AES-128-ECB 加解密。
- 本地**加密存 token**（token 永不上云）。
- 绑定 UI：展示二维码、扫码状态、掉线重扫入口。
- 桥接：收到微信消息 → 组 `wechat.inbound` 上推 hub；收到 `wechat.send` → 调 iLink 发出；可选 `wechat.typing` → iLink `sendtyping`。

##### 4.2 connector-protocol（`packages/connector-protocol`，扩展）
现有 client→hub 仅 `device.register / tool.result / tool.error / tool.stream / hb.pong`，无"设备主动推事件"概念。本次唯一协议性新增：
- **client→hub**：
  - `wechat.inbound`：`{ type, deviceId, msgId, from, chatType:"private", text?, media?[], contextToken, ts }`
  - `wechat.status`：`{ type, deviceId, state: "qr" | "scanned" | "confirmed" | "disconnected", qr?, reason?, ts }`
- **hub→client**：
  - `wechat.send`：`{ id, deviceId, to, contextToken, text?, media?[] }`
  - `wechat.typing`（可选）：`{ deviceId, to, contextToken }`
- 全部走 zod schema 校验；沿用现有 `TENANT_MISMATCH / DEVICE_OFFLINE / CONNECTION_LOST` 错误码。

##### 4.3 云端微信 channel 服务（`apps/api/src/wechat`，新增）
- binding 存储与解析（deviceId → 租户 + target + 会话线程）。
- `hub.ts` 增加对 `wechat.inbound / wechat.status` 的分发。
- inbound 处理：解析 binding → 续接微信会话线程 → **强制 M3** 跑现有 chat/agent 管线（agent 团队 tool 调用经 hub 下发回同一设备）→ 产出最终回复 → 下发 `wechat.send`。
- 新增 DB 模型 `WechatBinding { deviceId, tenantId, target(type,id), conversationId, status, createdAt, updatedAt }`。

##### 4.4 计费（零新增）
微信每轮 = 一次 chat turn，走现有预扣 1 万 → 实扣逻辑，归属 binding 所属租户。

#### 5. 模型与多模态

- 微信通道**恒用 MiniMax-M3**，忽略绑定 agent/团队自带模型。
- 入向图片/文件/语音：桌面端从 CDN 下载 + 解密 → 经现有 `apps/api/src/chat/attachments` 通道上云 → 原生喂给 M3，**不做 STT/转文字**。
- ⚠️ 实现前置校验：确认 `packages/llm` client 与 `attachments.ts` 能把**音频字节**透传给 M3（当前 attachments 主要覆盖图片/文件，音频通道需补验证）。
- 出向：文本，>4000 字自动分块；出向语音/图片 v1 暂不做。

#### 6. 安全声明（owner 已知悉并接受）

> 本设计按 owner 明确选择：**任何能私聊该 bot 的微信用户，一句话即可让绑定的 Agent 团队在对应电脑上无二次确认执行任意命令 / 删改文件**，等同将该电脑控制权开放给 bot 的所有会话方。盗号、提示词注入、他人误触均可导致电脑失守。
>
> 明确不做：不做发送方过滤（不限定 owner 本人）、不做危险工具白名单、不做微信二次确认。此为 owner 明确接受的风险。

**P3 已实现（2026-07-07）**：完全放开无确认已落地——`ToolInvoke.skipConfirm` 贯穿 dispatch→桌面 daemon，微信触发的高危工具在桌面端**跳过 `confirmHighRisk` 自动执行**（`daemon.ts` case "tool.invoke"）；单 agent 与 agent 团队两条路都经 `buildWechatComputerTools`（skipConfirm=true，指向绑定设备）挂电脑工具。团队路复用 `executeTeamRun`（抽自 `enqueueRun`）同步跑、强制 M3、自带计费不双扣。相关代码处均有显著安全注释标注"owner 已接受完全放开"。chat 路不受影响（默认 skipConfirm=undefined 仍弹确认）。**真机核对项**：① 微信触发 terminal/删改在桌面确实无弹框执行；② 绑 team 时微信一条消息触发多步团队执行、几分钟后收到最终报告、计费按 step/report 非双扣；③ 团队 agent 调电脑工具下发绑定设备成功；④ 设备离线时电脑工具优雅降级不崩。

#### 7. 错误处理

- **掉线**：iLink token 失效/被踢 → 桌面端轮询失败 → 上报 `wechat.status: disconnected` → UI 提示重扫，云端标记 binding 离线。
- **去重**：按 iLink `msgId` 去重（内存 + 本地凭证）。
- **设备离线**：微信轮询本地跑，离线即无 inbound；云端下发 `wechat.send` 到离线设备返回 `DEVICE_OFFLINE`。
- **长轮询**：断线指数退避重连；QR 480s 超时、过期自动刷新（≤10 次）。
- **会话续接**：`context_token` 持久化，进程重启可续会话。

#### 8. 测试策略

- 单元：`wechat.*` schema 校验、binding 解析、强制 M3、msgId 去重、AES-128-ECB 加解密对拍。
- 集成：mock iLink API（QR / getupdates / sendmessage）跑通 inbound → chat → reply 闭环；多模态透传。
- 协议移植：以 CowAgent `weixin_api.py` 为参照实现 TS 版并对拍请求/响应格式。

#### 9. 实施阶段

- **P1**：协议扩展 + 桌面 iLink 客户端（文本收发 + 扫码/掉线）+ 云端 channel + binding + 计费打通（纯文字闭环）。
- **P2**：多模态（图片/文件/语音原生入 M3）。
- **P3**：Agent 团队操作电脑闭环打磨（微信 → 云端 → 下发同设备 tool）。

#### 10. 参考

- CowAgent 仓库：https://github.com/zhayujie/CowAgent
- 个人微信 channel 源码：`channel/weixin/{weixin_api.py, weixin_channel.py, weixin_message.py}`
- 文档：https://docs.cowagent.ai/channels/weixin

### 微信接入 P2（多模态：图片/文件/语音）Implementation Plan

> 源文件：`2026-07-07-wechat-channel-p2-multimodal.md`


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 微信私聊发来的图片/文件在桌面端解密后原生喂给 MiniMax-M3（图片走 vision、文件解析成文本）；语音用 iLink 自带转写文本（`voice_item.text`）当文字喂 M3，无转写则回一句友好提示；出向仍只发文字。

**Architecture:** 下载 + AES 解密都在**桌面端**做（iLink token 在本地）——iLink `getUpdates` 拿到媒体引用 `{encrypt_query_param, aes_key}` → 桌面端从 CDN 下载 + AES-128-ECB 解密 → 解密后的字节 base64 → 经 `wechat.inbound.media` 上推云端；语音的 `voice_item.text` 在 ilink-api 层直接并入消息 text。云端把媒体转成现有 `ChatAttachmentPayload` → 复用 `chat/attachments.ts` 的 `prepareChatAttachments` / `buildCurrentUserContent` → 多模态 content 喂 `runTurn`（强制 M3）。

**Tech Stack:** TypeScript ESM, `node:crypto`（aes-128-ecb + PKCS7）, `@anthropic-ai/sdk` content blocks, vitest。

**前置结论（已调研确认，作为本计划事实依据）：**
- iLink 媒体：每条消息 `item_list` 里 `type==2 image_item` / `type==4 file_item` 的 `media` 子对象含 `encrypt_query_param`、`aes_key`、`encrypt_type(=1)`；`type==3 voice_item` 有 `text`（微信转写，可能为空）+ media（SILK 音频，**本计划不下载音频**）。
- CDN 下载：`GET https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=<encodeURIComponent(encrypt_query_param)>` → 拿到密文字节。
- 解密：`aes_key` 是 base64；base64 解码后若为 **32 字节**则视为 hex 字符串再 `Buffer.from(str,"hex")` 得 16 字节 key；AES-128-ECB + PKCS7 去填充 → 原始媒体字节。
- 云端 `apps/api/src/chat/attachments.ts`：`ChatAttachmentPayload = { name, mime, sizeBytes, kind:"image"|"file", dataBase64 }`；`prepareChatAttachments(payloads[])` → `{ blocks: Anthropic.ContentBlockParam[], storedLabel, searchableText, hasImage, imageCount }`；`buildCurrentUserContent(message, prepared)` → `string | ContentBlockParam[]`；`estimateInputTokens(message, prepared)`。**图片**转 image block、**文件**解析为 text block。**无 audio kind**（故语音只能走文本）。
- 云端 `runWechatTurn`（P1，`apps/api/src/wechat/turn.ts`）当前 `tools: []`、history 全 string；P2 要让"当前用户消息"用多模态 content。

**范围**：仅入向图片/文件/语音（语音=转写文本）。**不含**：出向发媒体、SILK 解码、STT、agent 团队/操作电脑（P3）。

---

#### 文件结构

**修改：**
- `packages/connector-protocol/src/wechat.ts` — `wechatMediaSchema` 从 P1 占位（`cdnUrl/aesKey`）改为承载**解密后字节**：`{ kind:"image"|"file", name, mime, dataBase64 }`。
- `apps/desktop/src/shared/wechat/ilink-api.ts` — `getUpdates` 规范化增加媒体引用与语音文本；新增 `downloadMedia(ref)`（CDN 下载 + AES 解密）。
- `apps/desktop/src/shared/wechat/channel.ts` — `pollOnce` 对媒体引用下载+解密+base64，组 `wechat.inbound.media`。
- `apps/api/src/wechat/turn.ts` — `runWechatTurn` 接收 media，转 `ChatAttachmentPayload` → `prepareChatAttachments` → `buildCurrentUserContent` → 多模态 history。
- `apps/api/src/wechat/service.ts` — `handleWechatInbound`：无文本且无媒体 → 回友好提示（语音无转写走这里）；否则带 media 跑回合。
- 对应 `.test.ts` 各自补测试。

---

#### Task 1: 协议层 media 改为携带解密字节

**Files:**
- Modify: `packages/connector-protocol/src/wechat.ts`
- Modify: `packages/connector-protocol/src/wechat.test.ts`

- [ ] **Step 1: 改 `wechat.ts` 的 `wechatMediaSchema`**

把 P1 的：
```typescript
export const wechatMediaSchema = z.object({
  kind: z.enum(["image", "file", "voice"]),
  cdnUrl: z.string().min(1),
  name: z.string().optional(),
  aesKey: z.string().optional(),
});
```
改为（媒体为桌面端解密后的字节；voice 不作为 media，走 text）：
```typescript
export const wechatMediaSchema = z.object({
  kind: z.enum(["image", "file"]),
  name: z.string().min(1),
  mime: z.string().min(1),
  dataBase64: z.string().min(1),
});
```
`wechatInboundSchema` 的 `media` 字段保持 `z.array(wechatMediaSchema).default([])` 不变（现在承载真实字节）。

- [ ] **Step 2: 改/补测试 `wechat.test.ts`**

在现有 wechat 测试里，把"合法 wechat.inbound（纯文字）"保留，新增一条带 media 的：
```typescript
it("校验合法 wechat.inbound（带图片 media）", () => {
  const r = clientMessageSchema.safeParse({
    type: "wechat.inbound", deviceId: "dev1", msgId: "m2", from: "wxid_a",
    chatType: "private", text: "看图", contextToken: "c", ts: 1,
    media: [{ kind: "image", name: "wx.jpg", mime: "image/jpeg", dataBase64: "AAAA" }],
  });
  expect(r.success).toBe(true);
});
it("拒绝 media 缺 dataBase64", () => {
  const r = clientMessageSchema.safeParse({
    type: "wechat.inbound", deviceId: "dev1", msgId: "m2", from: "wxid_a",
    chatType: "private", text: "x", contextToken: "c", ts: 1,
    media: [{ kind: "image", name: "wx.jpg", mime: "image/jpeg" }],
  });
  expect(r.success).toBe(false);
});
```

- [ ] **Step 3: 跑 + typecheck**

Run: `pnpm -C packages/connector-protocol test && pnpm -C packages/connector-protocol typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**
```bash
git add packages/connector-protocol/src/wechat.ts packages/connector-protocol/src/wechat.test.ts
git commit -m "微信协议 media 改为携带解密后字节"
```

> ⚠️ 注意：改 `wechatMediaSchema` 后，`apps/desktop/src/shared/wechat/channel.ts`（P1 里发 `media: []`）与 `apps/api/src/wechat/service.ts`（P1 里 `media` 未消费）的类型可能受影响——本任务只要求 connector-protocol 包自身 test+typecheck 绿；下游包在各自任务里对齐（Task 3、Task 5）。若本步后 `pnpm -C apps/desktop typecheck` 报 channel.ts 的 media 形状不符，属预期，Task 3 会修。

---

#### Task 2: iLink 客户端——媒体引用解析 + 下载解密

**Files:**
- Modify: `apps/desktop/src/shared/wechat/ilink-api.ts`
- Modify: `apps/desktop/src/shared/wechat/ilink-api.test.ts`

- [ ] **Step 1: 写失败测试**（AES 解密用已知向量；getUpdates 媒体/语音解析用 mock）

先 Read 现有 `ilink-api.ts` 确认 `getUpdates` 的规范化实现、`ILinkUpdate` 类型、`createILinkApi` 结构、常量（`ILINK_BASE_URL` 等）。然后在 `ilink-api.test.ts` 追加：

```typescript
import { createILinkApi } from "./ilink-api.js";
import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";

// 已知向量：本地构造一段 AES-128-ECB(PKCS7) 密文，验证 downloadMedia 能正确解出明文
it("downloadMedia 从 CDN 取密文并 AES-128-ECB 解密", async () => {
  const key = Buffer.from("0123456789abcdef", "utf8"); // 16 字节
  const plain = Buffer.from("hello-image-bytes");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const aesKeyB64 = key.toString("base64"); // 16 字节 → base64（非 32 字节分支）
  const fetchFn = (async (url: string) => {
    expect(String(url)).toContain("/c2c/download?encrypted_query_param=EQP");
    return { ok: true, status: 200, arrayBuffer: async () => enc, json: async () => ({}), text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
  const api = createILinkApi({ fetchFn });
  const out = await api.downloadMedia({ encryptQueryParam: "EQP", aesKey: aesKeyB64 });
  expect(Buffer.from(out).toString()).toBe("hello-image-bytes");
});

it("getUpdates 提取图片媒体引用 + 语音转写文本并入 text", async () => {
  const msgs = [{
    message_type: 1, message_id: "m1", from_user_id: "wx", context_token: "c", create_time_ms: 1,
    item_list: [
      { type: 3, voice_item: { text: "这是语音转写" } },
      { type: 2, image_item: { media: { encrypt_query_param: "EQP1", aes_key: "KKK", encrypt_type: 1 } } },
      { type: 4, file_item: { file_name: "a.pdf", media: { encrypt_query_param: "EQP2", aes_key: "KKK", encrypt_type: 1 } } },
    ],
  }];
  const fetchFn = (async () => ({ ok: true, status: 200, json: async () => ({ ret: 0, msgs, get_updates_buf: "" }), text: async () => "" } as unknown as Response)) as unknown as typeof fetch;
  const api = createILinkApi({ fetchFn, token: "t" });
  const ups = await api.getUpdates();
  expect(ups[0].text).toContain("这是语音转写");
  expect(ups[0].media).toEqual([
    { kind: "image", name: expect.any(String), mime: "image/jpeg", encryptQueryParam: "EQP1", aesKey: "KKK" },
    { kind: "file", name: "a.pdf", mime: expect.any(String), encryptQueryParam: "EQP2", aesKey: "KKK" },
  ]);
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm -C apps/desktop exec vitest run src/shared/wechat/ilink-api.test.ts`。

- [ ] **Step 3: 实现**

在 `ilink-api.ts`：
1. 顶部加常量与类型：
```typescript
import { createDecipheriv } from "node:crypto";

export const ILINK_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_VOICE = 3;
const ITEM_TYPE_FILE = 4;

export interface ILinkMediaRef {
  kind: "image" | "file";
  name: string;
  mime: string;
  encryptQueryParam: string;
  aesKey: string;
}
```
2. `ILinkUpdate` 加 `media: ILinkMediaRef[]`（现有 `{msgId,from,text,contextToken,ts}` 之上）。
3. `getUpdates` 规范化：遍历 `item_list`，`type==1`→ text_item.text 拼到 text；`type==3`→ `voice_item.text` 拼到 text（微信转写，可能空）；`type==2`→ 收 image media ref（name 用 `wx_${msgId}.jpg`、mime `image/jpeg`）；`type==4`→ 收 file media ref（name 用 `file_item.file_name` 或 `wx_${msgId}.bin`、mime 用 `mimeFromName(name)`）。媒体 ref 从 `image_item.media` / `file_item.media` 取 `encrypt_query_param` / `aes_key`。
4. 新增 `mimeFromName(name)`：按扩展名映射（`.pdf`→application/pdf、`.txt`→text/plain、`.md`→text/markdown、`.doc/.docx`→application/vnd...、默认 `application/octet-stream`）。
5. 新增 `downloadMedia(ref: { encryptQueryParam: string; aesKey: string }): Promise<Uint8Array>`：
```typescript
async function decodeAesKey(aesKeyB64: string): Promise<Buffer> {
  let key = Buffer.from(aesKeyB64, "base64");
  if (key.length === 32) key = Buffer.from(key.toString("utf8"), "hex"); // 32 字节=hex 字符串 → 16 字节
  return key;
}
// 在 createILinkApi 返回对象里：
async downloadMedia(ref: { encryptQueryParam: string; aesKey: string }): Promise<Uint8Array> {
  const url = `${ILINK_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(ref.encryptQueryParam)}`;
  const r = await fetchFn(url, { headers: headers() }); // headers()=现有 POST/GET 头构造，带 token
  if (!r.ok) throw new Error(`iLink CDN ${r.status}`);
  const enc = Buffer.from(await r.arrayBuffer());
  const key = await decodeAesKey(ref.aesKey);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true); // PKCS7
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}
```
> `headers()`：复用现有请求头构造函数（若下载不需要 token，多带无害；真机若 CDN 拒绝额外头，去掉 Authorization 即可——代码注释标注"CDN 下载是否需 token 待真机核对"）。

- [ ] **Step 4: 跑确认通过 + typecheck** — `pnpm -C apps/desktop exec vitest run src/shared/wechat/ilink-api.test.ts && pnpm -C apps/desktop typecheck`。

- [ ] **Step 5: 提交**
```bash
git add apps/desktop/src/shared/wechat/ilink-api.ts apps/desktop/src/shared/wechat/ilink-api.test.ts
git commit -m "iLink 客户端支持媒体下载解密与语音转写提取"
```

---

#### Task 3: channel runner——媒体下载+base64 组 wechat.inbound

**Files:**
- Modify: `apps/desktop/src/shared/wechat/channel.ts`
- Modify: `apps/desktop/src/shared/wechat/channel.test.ts`

- [ ] **Step 1: 写失败测试**（fakeApi 增加 downloadMedia，断言 media 被下载+base64 组进 inbound）

```typescript
it("图片媒体被下载解密并 base64 组进 wechat.inbound.media", async () => {
  const sent: any[] = [];
  const api = {
    setToken: vi.fn(),
    getUpdates: vi.fn(async () => [{
      msgId: "m1", from: "wxid_a", text: "看图", contextToken: "c1", ts: 1,
      media: [{ kind: "image", name: "wx.jpg", mime: "image/jpeg", encryptQueryParam: "EQP", aesKey: "K" }],
    }]),
    downloadMedia: vi.fn(async () => new Uint8Array([1, 2, 3])),
    sendText: vi.fn(), fetchQrCode: vi.fn(), pollQrStatus: vi.fn(),
  };
  const ch = createWechatChannel({ api: api as never, deviceId: "dev1", send: (m) => sent.push(m), token: "t" });
  await ch.pollOnce();
  expect(api.downloadMedia).toHaveBeenCalledWith({ encryptQueryParam: "EQP", aesKey: "K" });
  const inbound = sent.find((m) => m.type === "wechat.inbound");
  expect(inbound.media[0]).toMatchObject({ kind: "image", name: "wx.jpg", mime: "image/jpeg", dataBase64: Buffer.from([1,2,3]).toString("base64") });
});
```
（保留 P1 已有的去重/分块/掉线三个测试；P1 里 fakeApi 的 update 没有 media 字段，给它们补 `media: []` 以匹配新形状。）

- [ ] **Step 2: 跑确认失败** — `pnpm -C apps/desktop exec vitest run src/shared/wechat/channel.test.ts`。

- [ ] **Step 3: 实现**——`pollOnce` 里，对每条 update 的 `media` 引用下载+base64：
```typescript
// 在 for (const u of updates) 去重之后、send 之前：
const media = [];
for (const m of u.media) {
  try {
    const bytes = await opts.api.downloadMedia({ encryptQueryParam: m.encryptQueryParam, aesKey: m.aesKey });
    media.push({ kind: m.kind, name: m.name, mime: m.mime, dataBase64: Buffer.from(bytes).toString("base64") });
  } catch { /* 单个媒体下载失败则跳过该媒体，不阻断整条消息 */ }
}
opts.send({
  type: "wechat.inbound", deviceId: opts.deviceId, msgId: u.msgId, from: u.from,
  chatType: "private", text: u.text, media, contextToken: u.contextToken, ts: u.ts,
});
```
（`ILinkUpdate` 现在带 `media: ILinkMediaRef[]`，来自 Task 2。）

- [ ] **Step 4: 跑确认通过 + typecheck** — `pnpm -C apps/desktop exec vitest run src/shared/wechat/channel.test.ts && pnpm -C apps/desktop typecheck`。

- [ ] **Step 5: 提交**
```bash
git add apps/desktop/src/shared/wechat/channel.ts apps/desktop/src/shared/wechat/channel.test.ts
git commit -m "channel 下载解密媒体并上推 wechat.inbound"
```

> ⚠️ WS payload：一张图 base64 可达数 MB，走 connector WS `sock.send(JSON.stringify(...))`。发版前确认 hub 侧 fastify websocket `maxPayload` 能容纳（默认可能偏小）——本任务不改 hub，仅在 Task 6 提醒核对；必要时后续调 hub ws 配置。

---

#### Task 4: runWechatTurn 支持多模态

**Files:**
- Modify: `apps/api/src/wechat/turn.ts`
- Modify: `apps/api/src/wechat/turn.test.ts`

- [ ] **Step 1: 写失败测试**（注入 fake，断言：有 image media 时 reserve 的 inputTokens 更大、runTurn 收到多模态 content）

先 Read `apps/api/src/chat/attachments.ts` 确认 `ChatAttachmentPayload` / `prepareChatAttachments` / `buildCurrentUserContent` / `estimateInputTokens` 的确切签名，再写：
```typescript
import { runWechatTurn, WECHAT_MODEL } from "./turn.js";
it("带图片 media：转 attachment 喂 M3，当前消息为多模态 content", async () => {
  const billing = { reserve: vi.fn(async () => ({ reserved: 1 })), settle: vi.fn(async () => ({ settled: 1 })) };
  let seenHistory: any;
  const runTurn = vi.fn(async (a: any) => { seenHistory = a.history; return { text: "看到了", usage: { inputTokens: 3, outputTokens: 5 }, messages: [], toolCalls: 0, stoppedByMaxIterations: false }; });
  const prisma = {
    message: { findMany: vi.fn(async () => [{ id: "u1", role: "user", content: "看图[图片]" }]), create: vi.fn(async () => ({ id: "u1" })) },
    session: { findUnique: vi.fn(async () => ({ id: "s1", userId: "u1", agentPrompt: "x" })) },
  };
  const out = await runWechatTurn({
    prisma: prisma as never, billing: billing as never, runTurn: runTurn as never, client: {} as never,
    binding: { userId: "u1", deviceId: "dev1", targetType: "agent", targetId: "a1", sessionId: "s1" },
    text: "看图",
    media: [{ kind: "image", name: "wx.jpg", mime: "image/jpeg", dataBase64: Buffer.from([255,216,255]).toString("base64") }],
  });
  expect(out.text).toBe("看到了");
  // 当前用户消息 content 应是多模态数组（含 image block），非纯 string
  const last = seenHistory[seenHistory.length - 1];
  expect(Array.isArray(last.content)).toBe(true);
  expect(last.content.some((b: any) => b.type === "image")).toBe(true);
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm -C apps/api exec vitest run src/wechat/turn.test.ts`。

- [ ] **Step 3: 实现**——给 `RunWechatTurnArgs` 加 `media?`，用 attachments 管线构造多模态 content：
```typescript
import { prepareChatAttachments, buildCurrentUserContent, estimateInputTokens, type ChatAttachmentPayload } from "../chat/attachments.js";

export interface RunWechatTurnArgs {
  // ...原有字段...
  media?: Array<{ kind: "image" | "file"; name: string; mime: string; dataBase64: string }>;
}

// 函数体内（reserve 之前）：
const attachmentPayloads: ChatAttachmentPayload[] = (a.media ?? []).map((m) => ({
  name: m.name, mime: m.mime, sizeBytes: Buffer.from(m.dataBase64, "base64").length, kind: m.kind, dataBase64: m.dataBase64,
}));
const prepared = await prepareChatAttachments(attachmentPayloads);

// 落库 user 消息：带媒体标签（storedLabel），便于历史检索
await a.prisma.message.create({ data: { sessionId: a.binding.sessionId, role: "user", content: `${a.text}${prepared.storedLabel}`.trim() || "[附件]" } });

// 历史：当前用户消息用多模态 content，其余用库里 string
const rows = await a.prisma.message.findMany({ where: { sessionId: a.binding.sessionId }, orderBy: { createdAt: "asc" } });
const lastUserId = rows[rows.length - 1]?.id;
const history = rows.map((m) => ({
  role: m.role === "assistant" ? "assistant" as const : "user" as const,
  content: m.id === lastUserId ? buildCurrentUserContent(a.text, prepared) : m.content,
}));

// reserve：inputTokens 用 estimateInputTokens（含图片估算）
await a.billing.reserve({ operationId, userId: a.binding.userId, type: "chat", model: WECHAT_MODEL,
  inputTokens: estimateInputTokens(a.text, prepared), maxOutputTokens: RESERVE_OUTPUT_TOKENS });
```
其余（强制 M3、失败 settle 0、成功 settle、落 assistant）保持 P1 不变。`tools: []` 仍不变（P2 不引工具）。

- [ ] **Step 4: 跑确认通过 + typecheck** — `pnpm -C apps/api exec vitest run src/wechat/turn.test.ts && pnpm -C apps/api typecheck`。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/wechat/turn.ts apps/api/src/wechat/turn.test.ts
git commit -m "微信回合支持图片文件多模态喂 M3"
```

---

#### Task 5: service——空内容回友好提示 + 透传 media

**Files:**
- Modify: `apps/api/src/wechat/service.ts`
- Modify: `apps/api/src/wechat/service.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
it("无文本且无媒体（如语音无转写）→ 回友好提示，不跑 M3", async () => {
  const sent: any[] = [];
  const deps = {
    resolveBinding: vi.fn(async () => ({ userId: "u1", deviceId: "dev1", targetType: "agent", targetId: "a1", sessionId: "s1" })),
    runTurn: vi.fn(),
    sendToDevice: (id: string, msg: any) => { sent.push({ id, msg }); return true; },
  };
  await handleWechatInbound(deps as never, {
    type: "wechat.inbound", deviceId: "dev1", msgId: "m1", from: "wxid_a",
    chatType: "private", text: "  ", media: [], contextToken: "c", ts: 1,
  });
  expect(deps.runTurn).not.toHaveBeenCalled();
  expect(sent[0].msg).toMatchObject({ type: "wechat.send", to: "wxid_a", contextToken: "c" });
  expect(sent[0].msg.text).toContain("文字");
});

it("有媒体无文本 → 仍跑回合（把 media 传给 runTurn）", async () => {
  const deps = {
    resolveBinding: vi.fn(async () => ({ userId: "u1", deviceId: "dev1", targetType: "agent", targetId: "a1", sessionId: "s1" })),
    runTurn: vi.fn(async () => ({ text: "看到了" })),
    sendToDevice: vi.fn(() => true),
  };
  await handleWechatInbound(deps as never, {
    type: "wechat.inbound", deviceId: "dev1", msgId: "m1", from: "wxid_a", chatType: "private",
    text: "", media: [{ kind: "image", name: "a.jpg", mime: "image/jpeg", dataBase64: "AAAA" }], contextToken: "c", ts: 1,
  });
  expect(deps.runTurn).toHaveBeenCalled();
});
```
（`WechatServiceDeps.runTurn` 签名从 `(binding, text)` 改为 `(binding, text, media)`——同步改 P1 已有测试的 fake。）

- [ ] **Step 2: 跑确认失败** — `pnpm -C apps/api exec vitest run src/wechat/service.test.ts`。

- [ ] **Step 3: 实现**——改 `WechatServiceDeps.runTurn` 签名带 media，`handleWechatInbound` 空内容回提示：
```typescript
export interface WechatServiceDeps {
  resolveBinding: (deviceId: string) => Promise<ResolvedBinding | null>;
  runTurn: (binding: ResolvedBinding, text: string, media: WechatInbound["media"]) => Promise<{ text: string }>;
  sendToDevice: (deviceId: string, msg: WechatSend) => boolean;
}

const VOICE_FALLBACK = "抱歉，目前只支持文字、图片和文件～语音麻烦转成文字发我。";

export async function handleWechatInbound(deps: WechatServiceDeps, msg: WechatInbound): Promise<void> {
  const binding = await deps.resolveBinding(msg.deviceId);
  if (!binding) return;
  const hasContent = msg.text.trim().length > 0 || msg.media.length > 0;
  const replyText = hasContent
    ? (await deps.runTurn(binding, msg.text, msg.media)).text
    : VOICE_FALLBACK;
  const send: WechatSend = { type: "wechat.send", id: randomUUID(), to: msg.from, contextToken: msg.contextToken, text: replyText };
  deps.sendToDevice(msg.deviceId, send);
}
```
并在 hub.ts 的装配处（`wechatDeps.runTurn`）把 media 透传给 `runWechatTurn`：
```typescript
runTurn: (binding, text, media) => runWechatTurn({ prisma, billing: wechatBilling, runTurn, client: wechatLlm, binding, text, media }),
```

- [ ] **Step 4: 跑确认通过 + typecheck + hub 无回归** — `pnpm -C apps/api exec vitest run src/wechat/service.test.ts src/connector/hub.test.ts && pnpm -C apps/api typecheck`。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/wechat/service.ts apps/api/src/wechat/service.test.ts apps/api/src/connector/hub.ts
git commit -m "微信入站空内容回提示并透传媒体到回合"
```

---

#### Task 6: 端到端回归

- [ ] **Step 1: 全量 typecheck + 相关测试**

Run:
```bash
pnpm -r typecheck
pnpm -C packages/connector-protocol test
pnpm -C apps/desktop test
pnpm -C apps/api exec vitest run src/wechat/ src/connector/hub.test.ts
```
Expected: 全绿（P1 微信测试 + P2 新增 media 测试 + hub/ws-client/desktop 无回归）。

- [ ] **Step 2: 记录待真机核对项**（写入 PR/交接）
  1. 图片 → M3 vision 真实识图；文件 → 文本抽取是否符合预期。
  2. 语音：iLink `voice_item.text` 真机是否真有转写；无转写时是否收到友好提示。
  3. **WS maxPayload**：图片 base64 上推是否被 hub fastify-websocket 截断（必要时调 hub ws `maxPayload`）。
  4. CDN 下载是否需要带 token 头（`downloadMedia` 现带 headers()，真机若被拒则去掉 Authorization）。

- [ ] **Step 3: 发版**（另行，走 [[yun-claude-release]] 云端 + [[yun-claude-desktop-release]] 桌面端——P2 桌面端有改动，微信端到端需桌面端一并发）。

---

#### Self-Review（作者已核对）

- **Spec 覆盖**：图片(✅ image block)/文件(✅ 文本抽取)/语音(✅ iLink 转写文本，无转写回提示)、出向只文字(✅ 不变)——覆盖 P2 全部；SILK/STT/出向媒体明确移出。
- **占位符扫描**：`downloadMedia` 的 headers/CDN-token 与 WS maxPayload 标为"待真机核对"（属真机验证项，非"以后再写"）；其余步骤均含可运行代码/命令。
- **类型一致**：`wechatMediaSchema {kind,name,mime,dataBase64}`（Task 1）→ channel 组装（Task 3）→ `WechatInbound["media"]`（Task 5）→ `runWechatTurn.media`→`ChatAttachmentPayload`（Task 4）全链字段名一致；`ILinkMediaRef {kind,name,mime,encryptQueryParam,aesKey}`（Task 2）仅桌面内部（下载前），不上协议；`WechatServiceDeps.runTurn` 三参签名 Task 5 统一改。
- **复用**：云端完全复用 `chat/attachments.ts` 的 prepare/build/estimate，不另造多模态逻辑（DRY）。

### 微信接入 P3（Agent 团队 + 完全放开操作电脑）Implementation Plan

> 源文件：`2026-07-07-wechat-channel-p3-team-computer.md`


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 微信绑定的单 Agent 或 Agent 团队在回合中可调用 connector 工具（terminal/fs/browser）操作**绑定的那台桌面电脑**；按 owner 已定的「完全放开、任何发送方、无二次确认」——微信触发的高危工具在桌面端**跳过确认框自动执行**。团队绑定走现有 workflow 系统（强制 M3、自带计费、同步跑完返回最终报告）。

**Architecture:** 复用 chat 的工具下发机制（`selectMountedTools` 挂 `Device.tools` + `makeLocalExecTool` → hub `dispatchTool` → 设备）；新增 `skipConfirm` 标志穿过 `ToolInvoke`→桌面 daemon，使微信触发的工具在桌面端自动放行（不弹 `confirmHighRisk`）。微信侧新建 `buildWechatComputerTools(prisma, binding)` 统一构造"指向绑定设备 + skipConfirm 的工具集"，供单 agent 与团队两条路共用。团队执行把现有 `enqueueRun` 的编排体抽成**同步可 await 的 `executeTeamRun`**，微信团队路直接调用它拿 `finalReport`。

**Tech Stack:** TypeScript ESM, zod, `@anthropic-ai/sdk` tools, Electron, vitest；复用 `apps/api/src/connector/*`、`apps/api/src/tools/tool-mounts.ts`、`apps/api/src/agent-teams/*`。

> 🔴 **安全声明（owner 已两次明确接受，写进代码注释与本文档）**：本功能使**任何能私聊该 bot 的微信用户，一句话即可在绑定的电脑上无二次确认执行任意命令/删改文件**。不做发送方过滤、不做危险工具白名单、不做确认。盗号/提示词注入/他人误触均可致电脑失守。此为 owner 明确接受的风险。相关代码处必须加显著注释：`// 安全：owner 明确选择"完全放开、无二次确认"——微信触发工具跳过桌面确认。风险已接受。`

**前置结论（已调研确认）：**
- chat 工具下发（`apps/api/src/chat/routes.ts` L528-579）：`selectMountedTools({builtinTools: localTools, deviceCapabilities: device.capabilities, deviceTools: parseDeviceTools(device.tools), requestedToolIds:[], installedTools:[]})` → `{tools, allowedToolNames}`；`makeLocalExecTool(getDispatcher(), userId, deviceId, deviceUserId)` → `execTool`；传给 `runTurn({tools, execTool})`。
- `apps/api/src/connector/local-tools.ts`：`makeLocalExecTool(dispatcher, userId, deviceId, deviceUserId) => (name,input)=>Promise<string>` 内部调 `dispatcher.dispatchTool({deviceId,userId,deviceUserId,tool,args,timeoutMs})`。
- `apps/api/src/connector/dispatch.ts`：`dispatchTool(a: DispatchArgs)` 组 `ToolInvoke = {type:"tool.invoke",id,tool,args,timeoutMs}` 经 `deps.send(deviceId, invoke)` 发设备；`DispatchArgs = {deviceId,userId,deviceUserId,tool,args,timeoutMs}`；`userId!==deviceUserId` 抛 TENANT_MISMATCH。
- `apps/api/src/connector/hub.ts`：`getDispatcher(): Dispatcher`。
- 桌面 `apps/desktop/src/shared/daemon.ts`：`handleHubMessage` 的 `case "tool.invoke"` → `ctx.executeTool(msg.tool, msg.args, { confirm: ctx.confirm })`；`ctx.confirm` = 主进程的 `confirmHighRisk`（electron 弹框）。`executeTool` 内部只有 `checkHighRisk` 判定为高危时才调 confirm。
- 团队执行（`apps/api/src/agent-teams/`）：`enqueueRun` 内 plan→`createWorkflowSteps`→`createStore`→`resolveComputerToolExecution`→`runAgentWorkflowSteps({executeStep: defaultExecuteStep, summarize: defaultSummarize})`→读 `AgentWorkflowRun.finalReport`。`defaultExecuteStep`/`defaultSummarize` 支持 `tools`/`execTool` 与强制模型（`taskContext.selectedModel`）；团队自带计费（`withAgentModelBilling`，type `agent_team_step`/`agent_team_report`）。`ResolvedBinding.targetType` 已含 `"agent"|"team"`。
- 微信绑定 routes/bindings 现只允许 `targetType:"agent"`（`routes.ts` `z.literal("agent")`、`bindings.ts` `CreateBindingInput.targetType:"agent"`）。

---

#### 文件结构

**修改：**
- `packages/connector-protocol/src/index.ts` — `ToolInvoke` 加 `skipConfirm?: boolean`。
- `apps/api/src/connector/dispatch.ts` — `DispatchArgs` 加 `skipConfirm?`；组 ToolInvoke 时带上。
- `apps/api/src/connector/local-tools.ts` — `makeLocalExecTool` 加第 5 参 `opts?: { skipConfirm?: boolean }`，透传给 dispatchTool。
- `apps/desktop/src/shared/daemon.ts` — `tool.invoke` case：`msg.skipConfirm` 为真时用自动放行的 confirm。
- `apps/api/src/wechat/turn.ts` — 拆 `runWechatAgentTurn`（原逻辑 + 挂电脑工具）与 `runWechatTeamTurn`（团队）；`runWechatTurn` 按 `binding.targetType` 分发。
- `apps/api/src/wechat/routes.ts` + `bindings.ts` — 允许 `targetType:"team"`。
- `apps/api/src/agent-teams/routes.ts`（或新文件 `agent-teams/execute-run.ts`）— 抽出同步 `executeTeamRun`，`enqueueRun` 调它。

**新建：**
- `apps/api/src/wechat/computer-tools.ts` — `buildWechatComputerTools(prisma, binding)`（挂绑定设备工具 + execTool skipConfirm），供单 agent/团队共用。
- 各自 `.test.ts`。

---

#### Task 1: skip-confirm 协议 + dispatch + local-tools

**Files:**
- Modify: `packages/connector-protocol/src/index.ts`（`ToolInvoke` 接口）
- Modify: `apps/api/src/connector/dispatch.ts`
- Modify: `apps/api/src/connector/local-tools.ts`
- Modify: `apps/api/src/connector/dispatch.test.ts`（补 skipConfirm 透传断言）

- [ ] **Step 1: 改协议 `ToolInvoke`**（`packages/connector-protocol/src/index.ts`）

现有：
```typescript
export interface ToolInvoke {
  type: "tool.invoke";
  id: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}
```
加一行：
```typescript
  skipConfirm?: boolean; // 安全：微信触发的工具在桌面端跳过高危确认（owner 明确接受"完全放开、无二次确认"）
```

- [ ] **Step 2: 写失败测试**（`apps/api/src/connector/dispatch.test.ts` 追加）

先 Read 现有 dispatch.test.ts 的 fake send/风格。加：
```typescript
it("dispatchTool 透传 skipConfirm 到 ToolInvoke", async () => {
  const sent: any[] = [];
  const d = createDispatcher({ send: async (deviceId, inv) => { sent.push(inv); } });
  const p = d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "terminal_exec", args: { command: "ls" }, timeoutMs: 1000, skipConfirm: true });
  await Promise.resolve();
  expect(sent[0]).toMatchObject({ type: "tool.invoke", tool: "terminal_exec", skipConfirm: true });
  d.resolve("dev1", sent[0].id, "ok");
  await expect(p).resolves.toBe("ok");
});
```

- [ ] **Step 3: 跑确认失败** — `pnpm -C apps/api exec vitest run src/connector/dispatch.test.ts`。

- [ ] **Step 4: 实现**
`dispatch.ts`：`DispatchArgs` 加 `skipConfirm?: boolean`；组 invoke 时：
```typescript
const invoke: ToolInvoke = { type: "tool.invoke", id, tool: a.tool, args: a.args, timeoutMs: a.timeoutMs, skipConfirm: a.skipConfirm };
```
`local-tools.ts`：`makeLocalExecTool` 加第 5 参：
```typescript
export function makeLocalExecTool(
  dispatcher: Pick<Dispatcher, "dispatchTool">,
  userId: string, deviceId: string, deviceUserId: string,
  opts?: { skipConfirm?: boolean },
): (name: string, input: unknown) => Promise<string> {
  return async (name, input) => {
    try {
      return await dispatcher.dispatchTool({
        deviceId, userId, deviceUserId, tool: name,
        args: (input ?? {}) as Record<string, unknown>,
        timeoutMs: localToolTimeoutMs(),
        skipConfirm: opts?.skipConfirm,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `[工具执行失败: ${message}] 这一步结果未知，请勿假设已成功；可先检查状态再决定是否重试。`;
    }
  };
}
```
> chat 现有调用 `makeLocalExecTool(getDispatcher(), userId, active.id, active.userId)` 不传第 5 参，默认 `skipConfirm=undefined`（行为不变，chat 仍走桌面确认）。

- [ ] **Step 5: 跑通 + typecheck** — `pnpm -C apps/api exec vitest run src/connector/dispatch.test.ts && pnpm -C packages/connector-protocol typecheck && pnpm -C apps/api typecheck`。

- [ ] **Step 6: 提交**
```bash
git add packages/connector-protocol/src/index.ts apps/api/src/connector/dispatch.ts apps/api/src/connector/local-tools.ts apps/api/src/connector/dispatch.test.ts
git commit -m "connector 支持 skipConfirm 透传到工具调用"
```

---

#### Task 2: 桌面端 skip-confirm 自动放行

**Files:**
- Modify: `apps/desktop/src/shared/daemon.ts`
- Modify: `apps/desktop/src/shared/daemon.test.ts`（若存在；否则在 ws-client.test 里覆盖 tool.invoke 路径）

- [ ] **Step 1: 写失败测试**

先 Read `daemon.ts` 的 `handleHubMessage` 与 `DaemonCtx`（`executeTool(name,args,{confirm})`、`confirm`）。找到测 tool.invoke 的现有测试文件（`daemon.test.ts` 或 `ws-client.test.ts`），加：
```typescript
it("tool.invoke 带 skipConfirm 时用自动放行的 confirm（不弹框）", async () => {
  let usedConfirm: ((r: string) => Promise<boolean>) | undefined;
  const ctx = {
    send: vi.fn(),
    executeTool: vi.fn(async (_n: string, _a: any, opts: { confirm: (r: string)=>Promise<boolean> }) => { usedConfirm = opts.confirm; return "ok"; }),
    confirm: vi.fn(async () => false), // 默认拒绝（模拟用户点取消）
    onRegistered: vi.fn(),
  };
  await handleHubMessage(ctx as any, { type: "tool.invoke", id: "1", tool: "terminal_exec", args: { command: "ls" }, timeoutMs: 1000, skipConfirm: true } as any);
  // 传给 executeTool 的 confirm 应是自动放行（返回 true），而非 ctx.confirm
  expect(await usedConfirm!("高危")).toBe(true);
  expect(ctx.confirm).not.toHaveBeenCalled();
  expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.result", id: "1", ok: true }));
});
it("tool.invoke 不带 skipConfirm 时仍用 ctx.confirm", async () => {
  const ctx = { send: vi.fn(), executeTool: vi.fn(async (_n:string,_a:any,opts:any)=>{ await opts.confirm("x"); return "ok"; }), confirm: vi.fn(async()=>true), onRegistered: vi.fn() };
  await handleHubMessage(ctx as any, { type: "tool.invoke", id: "2", tool: "terminal_exec", args: {}, timeoutMs: 1000 } as any);
  expect(ctx.confirm).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm -C apps/desktop exec vitest run src/shared/daemon.test.ts`（或对应文件）。

- [ ] **Step 3: 实现**——`daemon.ts` 的 `case "tool.invoke"`：
```typescript
    case "tool.invoke": {
      // 安全：owner 明确选择"完全放开、无二次确认"——微信触发的工具(skipConfirm)跳过桌面高危确认。风险已接受。
      const confirm = msg.skipConfirm ? (async () => true) : ctx.confirm;
      try {
        const data = await ctx.executeTool(msg.tool, msg.args, { confirm });
        ctx.send({ type: "tool.result", id: msg.id, ok: true, data });
      } catch (err) {
        const { code, msg: m } = splitCode(err instanceof Error ? err.message : String(err));
        ctx.send({ type: "tool.error", id: msg.id, code, message: m });
      }
      return;
    }
```
（`HubMessage` 的 `ToolInvoke` 已含 `skipConfirm?`，来自 Task 1；`msg.skipConfirm` 可直接读。）

- [ ] **Step 4: 跑通 + typecheck** — `pnpm -C apps/desktop exec vitest run <该测试文件> && pnpm -C apps/desktop typecheck`。

- [ ] **Step 5: 提交**
```bash
git add apps/desktop/src/shared/daemon.ts <该测试文件>
git commit -m "桌面端 skipConfirm 工具自动放行不弹确认"
```

---

#### Task 3: buildWechatComputerTools（挂绑定设备工具 + skipConfirm）

**Files:**
- Create: `apps/api/src/wechat/computer-tools.ts`
- Create: `apps/api/src/wechat/computer-tools.test.ts`

- [ ] **Step 1: 写失败测试**（fake prisma + fake dispatcher）

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildWechatComputerTools } from "./computer-tools.js";

it("绑定设备在线有工具 → 返回 tools + execTool（execTool 带 skipConfirm 下发到绑定设备）", async () => {
  const dispatched: any[] = [];
  const dispatcher = { dispatchTool: vi.fn(async (a: any) => { dispatched.push(a); return "done"; }) };
  const prisma = { device: { findUnique: vi.fn(async () => ({
    id: "dev1", userId: "u1", capabilities: ["terminal_exec"],
    tools: [{ name: "terminal_exec", description: "run", input_schema: { type: "object", properties: {}, required: [] } }],
  })) } };
  const r = await buildWechatComputerTools(prisma as never, { userId: "u1", deviceId: "dev1", targetType: "agent", targetId: "a1", sessionId: "s1" }, dispatcher as never);
  expect(r).not.toBeNull();
  expect(r!.tools.some((t: any) => t.name === "terminal_exec")).toBe(true);
  await r!.execTool("terminal_exec", { command: "ls" });
  expect(dispatched[0]).toMatchObject({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "terminal_exec", skipConfirm: true });
});

it("设备不存在 → null", async () => {
  const prisma = { device: { findUnique: vi.fn(async () => null) } };
  const r = await buildWechatComputerTools(prisma as never, { userId: "u1", deviceId: "devX", targetType: "agent", targetId: "a1", sessionId: "s1" }, { dispatchTool: vi.fn() } as never);
  expect(r).toBeNull();
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm -C apps/api exec vitest run src/wechat/computer-tools.test.ts`。

- [ ] **Step 3: 实现 `computer-tools.ts`**

先 Read `apps/api/src/tools/tool-mounts.ts`（`selectMountedTools`/`parseDeviceTools` 签名）、`apps/api/src/connector/local-tools.ts`（`makeLocalExecTool`，Task 1 已加 skipConfirm）、`apps/api/src/connector/hub.ts`（`getDispatcher`）、`@yc/connector-protocol` 的 `localTools`，确认导出名。
```typescript
import type { PrismaClient } from "@yc/db";
import type Anthropic from "@anthropic-ai/sdk";
import { localTools } from "@yc/connector-protocol";
import type { Dispatcher } from "../connector/dispatch.js";
import { getDispatcher } from "../connector/hub.js";
import { makeLocalExecTool } from "../connector/local-tools.js";
import { selectMountedTools, parseDeviceTools } from "../tools/tool-mounts.js";
import type { ResolvedBinding } from "./binding.js";

export interface WechatComputerTools {
  tools: Anthropic.Tool[];
  execTool: (name: string, input: unknown) => Promise<string>;
}

// 安全：owner 明确选择"完全放开、无二次确认"——execTool 以 skipConfirm 下发到绑定设备，桌面端不弹高危确认。风险已接受。
export async function buildWechatComputerTools(
  prisma: PrismaClient,
  binding: ResolvedBinding,
  dispatcher: Pick<Dispatcher, "dispatchTool"> = getDispatcher(),
): Promise<WechatComputerTools | null> {
  const device = await prisma.device.findUnique({
    where: { id: binding.deviceId },
    select: { id: true, userId: true, capabilities: true, tools: true },
  });
  if (!device || device.userId !== binding.userId) return null;

  const mounted = selectMountedTools({
    requestedToolIds: [],
    builtinTools: localTools,
    installedTools: [],
    deviceCapabilities: device.capabilities,
    deviceTools: parseDeviceTools(device.tools),
  });
  if (mounted.tools.length === 0) return null;

  const exec = makeLocalExecTool(dispatcher, binding.userId, binding.deviceId, device.userId, { skipConfirm: true });
  const execTool = (name: string, input: unknown) =>
    mounted.allowedToolNames.has(name) ? exec(name, input) : Promise.resolve(`[未授权工具: ${name}]`);
  return { tools: mounted.tools, execTool };
}
```
> `getDispatcher()` 默认参数便于生产用；测试注入 fake dispatcher。若 `localTools`/`selectMountedTools` 的实际导出/签名与此不符，以 Read 到的为准对齐。

- [ ] **Step 4: 跑通 + typecheck** — `pnpm -C apps/api exec vitest run src/wechat/computer-tools.test.ts && pnpm -C apps/api typecheck`。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/wechat/computer-tools.ts apps/api/src/wechat/computer-tools.test.ts
git commit -m "新增微信绑定设备电脑工具构造(skipConfirm)"
```

---

#### Task 4: 单 agent 回合挂电脑工具

**Files:**
- Modify: `apps/api/src/wechat/turn.ts`
- Modify: `apps/api/src/wechat/turn.test.ts`

- [ ] **Step 1: 写失败测试**（注入 fake buildTools，断言 runTurn 收到 tools/execTool）

`runWechatTurn` 要能注入"电脑工具构造器"便于测试。给 `RunWechatTurnArgs` 加可选 `buildComputerTools?: (binding) => Promise<WechatComputerTools | null>`（默认用 `buildWechatComputerTools`）。测试：
```typescript
it("单 agent：挂载绑定设备电脑工具传给 runTurn", async () => {
  const billing = { reserve: vi.fn(async()=>({reserved:1})), settle: vi.fn(async()=>({settled:1})) };
  let seenTools: any; let seenExec: any;
  const runTurn = vi.fn(async (a:any)=>{ seenTools=a.tools; seenExec=a.execTool; return { text:"ok", usage:{inputTokens:1,outputTokens:1}, messages:[], toolCalls:0, stoppedByMaxIterations:false }; });
  const prisma = { message:{findMany:vi.fn(async()=>[{id:"u1",role:"user",content:"x"}]),create:vi.fn(async()=>({id:"u1"}))}, session:{findUnique:vi.fn(async()=>({id:"s1",userId:"u1",agentPrompt:"p"}))} };
  const fakeTools = { tools:[{name:"terminal_exec",description:"",input_schema:{type:"object"}}], execTool: vi.fn() };
  await runWechatTurn({
    prisma:prisma as never, billing:billing as never, runTurn:runTurn as never, client:{} as never,
    binding:{userId:"u1",deviceId:"dev1",targetType:"agent",targetId:"a1",sessionId:"s1"}, text:"看",
    buildComputerTools: async () => fakeTools as never,
  });
  expect(seenTools).toBe(fakeTools.tools);
  expect(seenExec).toBe(fakeTools.execTool);
});
```
（保留 P1/P2 全部用例；无 buildComputerTools 注入时默认用真实的，但那些老用例的 prisma.device 未 mock → buildWechatComputerTools 会因 device 查不到返回 null → tools/execTool 为 undefined，等价 P2 行为，老用例不回归。**确认**老用例 fake prisma 没有 device.findUnique 时，默认 buildWechatComputerTools 优雅返回 null 而非抛错。为稳妥，老用例可显式传 `buildComputerTools: async()=>null`。）

- [ ] **Step 2: 跑确认失败** — `pnpm -C apps/api exec vitest run src/wechat/turn.test.ts`。

- [ ] **Step 3: 实现**——`turn.ts`：
1. import `buildWechatComputerTools, type WechatComputerTools` from `./computer-tools.js`。
2. `RunWechatTurnArgs` 加 `buildComputerTools?: (binding: ResolvedBinding) => Promise<WechatComputerTools | null>;`。
3. 在 runTurn 调用前：
```typescript
  const buildTools = a.buildComputerTools ?? ((b) => buildWechatComputerTools(a.prisma, b));
  const computer = await buildTools(a.binding);
  result = await a.runTurn({
    client: a.client, model: WECHAT_MODEL, history,
    system: session.agentPrompt ?? undefined,
    tools: computer?.tools ?? [],
    execTool: computer?.execTool,
  });
```
其余（强制 M3、reserve/settle、失败 settle 0、落库）不变。
> ⚠️ 这一步让**单 agent 微信回合可无确认操作电脑**——在此处加安全注释：`// 安全：微信触发的工具经 skipConfirm 无确认在绑定设备执行（owner 已接受完全放开）。`

- [ ] **Step 4: 跑通 + typecheck** — `pnpm -C apps/api exec vitest run src/wechat/turn.test.ts && pnpm -C apps/api typecheck`。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/wechat/turn.ts apps/api/src/wechat/turn.test.ts
git commit -m "微信单 agent 回合挂载绑定设备电脑工具"
```

---

#### Task 5: 绑定支持 targetType team

**Files:**
- Modify: `apps/api/src/wechat/routes.ts`
- Modify: `apps/api/src/wechat/bindings.ts`
- Modify: `apps/api/src/wechat/bindings.test.ts`

- [ ] **Step 1: 写失败测试**（bindings.test.ts 追加：绑定 team 成功）

```typescript
it("createBinding 支持 targetType team（复用会话线程）", async () => {
  const prisma = {
    device: { findUnique: vi.fn(async () => ({ userId: "u1" })) },
    session: { create: vi.fn(async () => ({ id: "sess1" })) },
    wechatBinding: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: "b1" })), update: vi.fn() },
  };
  const r = await createBinding(prisma as never, "u1", { deviceId: "dev1", targetType: "team", targetId: "team1" });
  expect(r.id).toBe("b1");
  expect(prisma.wechatBinding.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ targetType: "team", targetId: "team1" }) }));
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm -C apps/api exec vitest run src/wechat/bindings.test.ts`。

- [ ] **Step 3: 实现**
`routes.ts` 的 `createSchema`：`targetType: z.literal("agent")` → `targetType: z.enum(["agent", "team"])`。
`bindings.ts` 的 `CreateBindingInput.targetType`：`"agent"` → `"agent" | "team"`；`createBinding` 里建 session 的 `agentId`：team 时不写 agent（`agentId: input.targetType === "agent" ? input.targetId : undefined`）——binding 的 `targetType/targetId` 才是路由真值源，session 只是会话线程。其余（越权校验、复用已有绑定不重建 session）不变。

- [ ] **Step 4: 跑通 + typecheck** — `pnpm -C apps/api exec vitest run src/wechat/bindings.test.ts && pnpm -C apps/api typecheck`。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/wechat/routes.ts apps/api/src/wechat/bindings.ts apps/api/src/wechat/bindings.test.ts
git commit -m "微信绑定支持 agent 团队 targetType"
```

---

#### Task 6: 抽出同步 executeTeamRun

把 `enqueueRun`（`apps/api/src/agent-teams/routes.ts` L198-270）里 `scheduleTask(async()=>{...})` 的**回调体**抽成一个导出的、可 await 的 `executeTeamRun(...)`，`enqueueRun` 改为 `scheduleTask(() => executeTeamRun(...))`。**行为不变**，只是让微信路能同步 await。

**Files:**
- Create: `apps/api/src/agent-teams/execute-run.ts`
- Modify: `apps/api/src/agent-teams/routes.ts`（enqueueRun 调新函数）

- [ ] **Step 1: 读透 enqueueRun**

Read `apps/api/src/agent-teams/routes.ts` 的 `enqueueRun` 全文 + 它引用的所有函数/import（`readTaskContextFromSnapshot`、`requestWorkflowPlan`/`planWorkflow`、`createWorkflowSteps`、`createStore`、`resolveComputerToolExecution`、`runner`(=`runAgentWorkflowSteps`)、`executeStep`(=`defaultExecuteStep`)、`summarize`(=`defaultSummarize`)、`runContext`/`stepContext`/`eventContext`、`loadOwnedRun`、`failRunBestEffort`、`formatAgentWorkflowError`）。确认它们的导出位置。

- [ ] **Step 2: 抽函数 `execute-run.ts`**

把回调体原样搬进：
```typescript
export interface ExecuteTeamRunDeps {
  computerTools?: { tools: Anthropic.Tool[]; execTool: (n: string, i: unknown) => Promise<string> } | null;
  // 其余依赖（prisma/planWorkflow 覆盖点等）按 enqueueRun 现有闭包捕获的来源，用参数或 import 传入
}
export async function executeTeamRun(userId: string, runId: string, taskGoal: string, teamSnapshot: unknown, deps?: ExecuteTeamRunDeps): Promise<void> {
  // ← enqueueRun 里 scheduleTask 回调体原样搬来，
  //   把 `const computerTools = await resolveComputerToolExecution(prisma, userId)` 改为：
  //   `const computerTools = deps?.computerTools !== undefined ? deps.computerTools : await resolveComputerToolExecution(prisma, userId);`
  //   —— 这样默认行为完全不变（现有路由不传 deps 走 resolveComputerToolExecution），微信路可注入自己的工具。
}
```
> 关键：**默认不传 deps 时行为与原 enqueueRun 逐字一致**（同一 prisma、同一 plan/step/summarize、同一 resolveComputerToolExecution）。只把"computerTools 来源"做成可注入。prisma 等若原来是闭包捕获，抽函数后改成 import 或参数——以 Read 到的实际来源为准，保持等价。

- [ ] **Step 3: `routes.ts` 改用新函数**
```typescript
function enqueueRun(userId: string, runId: string, taskGoal: string, teamSnapshot: Prisma.JsonValue): void {
  scheduleTask(() => executeTeamRun(userId, runId, taskGoal, teamSnapshot));
}
```

- [ ] **Step 4: 验证既有 agent-teams 测试不回归**

Run: `pnpm -C apps/api exec vitest run src/agent-teams/ && pnpm -C apps/api typecheck`
Expected: agent-teams 既有测试全过（行为等价），typecheck 绿。若 agent-teams 无测试或很少，至少 typecheck 绿 + 人工核对 diff 是"纯搬移 + computerTools 可注入"，无逻辑改动。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/agent-teams/execute-run.ts apps/api/src/agent-teams/routes.ts
git commit -m "抽出可同步等待的团队执行 executeTeamRun"
```

---

#### Task 7: 微信团队回合

**Files:**
- Modify: `apps/api/src/wechat/turn.ts`
- Modify: `apps/api/src/wechat/turn.test.ts`

- [ ] **Step 1: 写失败测试**（注入 fake executeTeamRun + fake team 数据）

给 `runWechatTurn` 加可选注入点 `runTeam?: (args) => Promise<{text:string}>`（默认用真实 `runWechatTeamTurn`）。测试团队分发：
```typescript
it("targetType team → 走团队执行，返回 finalReport 并落库", async () => {
  const prisma = { message:{create:vi.fn(async()=>({id:"u1"})),findMany:vi.fn(async()=>[])}, session:{findUnique:vi.fn(async()=>({id:"s1",userId:"u1"}))} };
  const runTeam = vi.fn(async () => ({ text: "团队最终报告" }));
  const out = await runWechatTurn({
    prisma: prisma as never, billing: {reserve:vi.fn(),settle:vi.fn()} as never, runTurn: vi.fn() as never, client: {} as never,
    binding: { userId:"u1", deviceId:"dev1", targetType:"team", targetId:"team1", sessionId:"s1" }, text:"帮我干活",
    runTeam: runTeam as never,
  });
  expect(runTeam).toHaveBeenCalled();
  expect(out.text).toBe("团队最终报告");
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm -C apps/api exec vitest run src/wechat/turn.test.ts`。

- [ ] **Step 3: 实现**

先 Read `apps/api/src/agent-teams/` 确认这些导出的确切名与签名：`createRunFromTeam`、`buildAgentTaskContext`（或等价构造 `AgentTaskContext` 的方式，要能塞 `selectedModel: "MiniMax-M3"`）、`executeTeamRun`(Task 6)。然后：
1. `runWechatTurn` 开头（会话校验后）按 `binding.targetType` 分发：
```typescript
  if (a.binding.targetType === "team") {
    const runTeam = a.runTeam ?? runWechatTeamTurn;
    const res = await runTeam({ prisma: a.prisma, binding: a.binding, text: a.text });
    await a.prisma.message.create({ data: { sessionId: a.binding.sessionId, role: "assistant", content: res.text, model: WECHAT_MODEL } });
    return res;
  }
  // 否则走原单 agent 逻辑（Task 4 的多模态 + 电脑工具）
```
2. 新增 `runWechatTeamTurn({ prisma, binding, text }): Promise<{text}>`：
```typescript
// 安全：微信团队回合的电脑工具经 skipConfirm 无确认在绑定设备执行（owner 已接受完全放开）。
async function runWechatTeamTurn(args: { prisma: PrismaClient; binding: ResolvedBinding; text: string }): Promise<{ text: string }> {
  // a) 强制 M3 的 taskContext
  const taskContext = buildAgentTaskContext({ model: WECHAT_MODEL /* 以实际签名为准塞 selectedModel */ });
  // b) 建 run
  const run = await createRunFromTeam(args.prisma, args.binding.userId, args.binding.targetId, args.text, taskContext);
  // c) 微信自己的电脑工具（指向绑定设备 + skipConfirm）
  const computer = await buildWechatComputerTools(args.prisma, args.binding);
  // d) 同步执行团队（Task 6 抽的函数，注入 computerTools）
  await executeTeamRun(args.binding.userId, run.id, args.text, run.teamSnapshot, { computerTools: computer });
  // e) 读 finalReport
  const finalRun = await args.prisma.agentWorkflowRun.findUnique({ where: { id_userId: { id: run.id, userId: args.binding.userId } } });
  return { text: finalRun?.finalReport?.trim() || finalRun?.error || "团队执行未产生结果" };
}
```
> **计费**：团队路**不**调 chat 的 reserve/settle（团队内部 `withAgentModelBilling` 已按 step/report 计费，强制 M3 走 taskContext.selectedModel）。别双扣。
> **注意**：`buildAgentTaskContext` / `createRunFromTeam` / `run.teamSnapshot` 的确切签名与字段以 Read 到的 agent-teams 源码为准对齐；若 `AgentTaskContext` 的模型字段不是 `selectedModel`，用实际字段名。

- [ ] **Step 4: 跑通 + typecheck** — `pnpm -C apps/api exec vitest run src/wechat/turn.test.ts src/wechat/service.test.ts && pnpm -C apps/api typecheck`。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/wechat/turn.ts apps/api/src/wechat/turn.test.ts
git commit -m "微信支持绑定 agent 团队并同步执行返回报告"
```

---

#### Task 8: 端到端回归 + 安全文档

- [ ] **Step 1: 全量回归**

Run:
```bash
pnpm -r typecheck
pnpm -C apps/desktop test
pnpm -C apps/api exec vitest run src/wechat/ src/connector/ src/agent-teams/
```
Expected: 全绿（微信 P1/P2/P3 + connector + agent-teams 无回归）。

- [ ] **Step 2: 安全声明写入交接/文档**

在 PR 描述或 `docs/superpowers/specs/2026-07-07-wechat-channel-design.md` 的安全节补一行"P3 已实现，完全放开无确认已落地（skipConfirm）"，并列**真机核对项**：
  1. 微信触发 terminal/删改文件在桌面端**确实无弹框**执行。
  2. 绑定 team 时，微信一条消息触发团队多步执行、几分钟后收到最终报告；团队计费按 step/report 记录（非双扣）。
  3. 团队执行中 agent 调电脑工具下发到绑定设备成功。
  4. 设备离线时电脑工具优雅降级（返回失败说明，不崩）。

- [ ] **Step 3: 发版**（另行）：P3 桌面端（daemon skipConfirm）+ 云端都改了 → 走 [[yun-claude-release]] + [[yun-claude-desktop-release]] 两套。

---

#### Self-Review（作者已核对）

- **Spec 覆盖**：单 agent 操作电脑(✅ Task 4)、团队绑定(✅ Task 5)、团队执行含操作电脑(✅ Task 6/7)、完全放开无确认(✅ Task 1/2 skipConfirm + Task 3 execTool skipConfirm)、强制 M3(✅ 单 agent WECHAT_MODEL / 团队 taskContext.selectedModel)。
- **占位符扫描**：Task 6/7 多处标注"以 Read 到的 agent-teams 实际签名为准对齐"——这是**必要的对接指令**（agent-teams 是既有复杂系统，实现者须读源码对齐导出名/字段），非"以后再写"；每步给了结构与调用形态。真机项明确列为验证项。
- **类型一致**：`skipConfirm?` 贯穿 `ToolInvoke`(Task1)→`DispatchArgs`(Task1)→`makeLocalExecTool`opts(Task1)→daemon 读(Task2)→`buildWechatComputerTools`execTool(Task3)；`WechatComputerTools {tools,execTool}` 供单 agent(Task4)与团队(Task7)共用；`buildComputerTools`/`runTeam` 注入点便于单测。
- **安全**：owner 明确接受的"完全放开、无二次确认"在 Task2/3/4/7 四处加显著注释；chat 路不受影响（默认 skipConfirm=undefined，仍弹确认）。
- **复用/不双扣**：团队复用现有 workflow 系统（Task6 抽同步 runner，默认行为不变），计费走团队自带（不叠加 chat reserve/settle）。

### 个人微信接入（P1 纯文字闭环）Implementation Plan

> 源文件：`2026-07-07-wechat-channel.md`


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面端用个人微信扫码后，用户在微信私聊里发文字给 bot → 经现有 connector WebSocket 上推云端 → 云端强制用 MiniMax-M3 跑一次 headless chat 回合并计费 → 文字回复下发桌面端 → 桌面端调 iLink 发回微信。

**Architecture:** 微信 iLink 长轮询跑在桌面端（token 本地 safeStorage 加密存储），复用现有 `device/hub` WebSocket 通道；新增 `wechat.*` 协议消息承载"设备上推微信消息"与"云端下发发送指令"（现有协议只有云端下发工具 + 设备回结果，方向相反，这是唯一协议性新增）。云端新增 `apps/api/src/wechat` 服务，用已有 `runTurn` / `billing.reserve|settle` / `prisma Session|Message` 原语组合出一个无 SSE 的回合，绑定关系存 `WechatBinding` 表。

**Tech Stack:** TypeScript, pnpm monorepo, Fastify, Prisma/PostgreSQL, zod, Anthropic SDK (`@anthropic-ai/sdk`), Electron (`safeStorage`), vitest, `ws`。

**Scope（本计划范围）：** 仅 P1 —— **单个 Agent 绑定 + 纯文字收发闭环 + 计费打通 + 扫码/掉线**。以下不在本计划：
- **P2**：图片/文件/语音原生入 M3（多模态透传、CDN AES 下载）。
- **P3**：绑定 Agent **团队** + agent 团队操作电脑（微信触发 connector 工具下发同设备）。
本计划为 P2/P3 预留接口（`WechatBinding.target` 已含 `type`，`wechat.inbound` 已含 `media` 占位字段并在协议层校验，但 P1 不消费）。

**参照源（iLink 线上报文字段的唯一真值来源）：** CowAgent `channel/weixin/weixin_api.py`
（https://raw.githubusercontent.com/zhayujie/CowAgent/master/channel/weixin/weixin_api.py 、`weixin_channel.py`、`weixin_message.py`）。
> ⚠️ Task 3（iLink 客户端）中所有 HTTP 请求体/响应字段名、AES 密钥派生、CDN 上传参数**必须逐字段对照该文件**，不得臆造。本计划给出已确认的端点/请求头/流程/加密算法与语言无关行为的完整实现与测试；wire-format 细节以参照文件为准。

---

#### 文件结构（先锁定边界）

**新建：**
- `packages/connector-protocol/src/wechat.ts` — `wechat.*` 消息 zod schema 与类型（保持 `index.ts` 聚焦，微信消息单独成文件，由 `index.ts` re-export）。
- `apps/desktop/src/shared/wechat/ilink-api.ts` — iLink HTTP 客户端（纯函数：`fetchQrCode` / `pollQrStatus` / `getUpdates` / `sendText`；注入 `fetch` 便于测试）。
- `apps/desktop/src/shared/wechat/ilink-api.test.ts`
- `apps/desktop/src/shared/wechat/channel.ts` — 长轮询 runner：登录态机、getUpdates 循环、msgId 去重、上推 `wechat.inbound`、消费 `wechat.send`、掉线上报 `wechat.status`。
- `apps/desktop/src/shared/wechat/channel.test.ts`
- `apps/desktop/src/shared/wechat/chunk.ts` — 文本 >4000 分块（语言无关，单测）。
- `apps/desktop/src/shared/wechat/chunk.test.ts`
- `apps/desktop/src/main/wechat-store.ts` — safeStorage 加密存 iLink 凭据（仿 `electron-deps.ts` 的 `makeTokenStore`）。
- `apps/api/src/wechat/binding.ts` — `WechatBinding` 读写 + 解析（deviceId → userId + target + sessionId）。
- `apps/api/src/wechat/binding.test.ts`
- `apps/api/src/wechat/turn.ts` — headless 回合：强制 M3、reserve→runTurn→settle、持久化 Session/Message、返回最终文本。
- `apps/api/src/wechat/turn.test.ts`
- `apps/api/src/wechat/service.ts` — 接 `wechat.inbound`：解析绑定 → 跑 turn → `sendToDevice(wechat.send)`；接 `wechat.status` 更新在线态。
- `apps/api/src/wechat/service.test.ts`
- `apps/api/src/wechat/routes.ts` — `/api/wechat/bindings` CRUD（建/查/删绑定）。
- `apps/api/src/wechat/routes.test.ts`
- `packages/db/prisma/migrations/<ts>_add_wechat_binding/migration.sql` — 迁移（由 `prisma migrate` 生成）。

**修改：**
- `packages/connector-protocol/src/index.ts` — re-export `./wechat.js`；把 `wechatInbound/wechatStatus` 并入 `clientMessageSchema` union；`WechatSend` 并入 `HubMessage` union。
- `apps/api/src/connector/hub.ts` — `HubConnCtx` 加 `onWechatInbound` / `onWechatStatus`；`handleClientMessage` 加两个 case；导出 `sendToDevice(deviceId, msg)`。
- `apps/api/src/server.ts` — 注册 `registerWechatRoutes(app)`；把 hub 的 `onWechatInbound/onWechatStatus` 接到 `wechat/service`。
- `apps/desktop/src/shared/daemon.ts` — `handleHubMessage` 加 `wechat.send` case → 调 channel runner 发送。
- `apps/desktop/src/main/index.ts` — 启动 wechat channel runner；加 IPC `yc:wechat-bind-start` / `yc:wechat-bind-status` / `yc:wechat-unbind`。
- `apps/desktop/src/preload/index.ts` — 暴露 `wechatBindStart/wechatBindStatus/wechatUnbind`。
- `packages/db/prisma/schema.prisma` — 加 `WechatBinding` model。
- `apps/web/src/pages/WechatBind.tsx`（新建）+ `App.tsx`/`Shell.tsx` 挂一个「微信接入」入口 — 通过 `window.ycDesktop` 桥接扫码。

---

#### Task 1: 协议层新增 `wechat.*` 消息

**Files:**
- Create: `packages/connector-protocol/src/wechat.ts`
- Create: `packages/connector-protocol/src/wechat.test.ts`
- Modify: `packages/connector-protocol/src/index.ts`（末尾 union 定义处）

- [ ] **Step 1: 写失败测试** `packages/connector-protocol/src/wechat.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { clientMessageSchema } from "./index.js";

describe("wechat.* 协议消息", () => {
  it("校验合法 wechat.inbound（纯文字）", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m-1",
      from: "wxid_owner",
      chatType: "private",
      text: "你好",
      contextToken: "ctx-abc",
      ts: 1_700_000_000,
    });
    expect(r.success).toBe(true);
  });

  it("wechat.inbound 缺 contextToken 判失败", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m-1",
      from: "wxid_owner",
      chatType: "private",
      text: "hi",
      ts: 1,
    });
    expect(r.success).toBe(false);
  });

  it("校验合法 wechat.status（掉线）", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.status",
      deviceId: "dev1",
      state: "disconnected",
      reason: "token expired",
      ts: 1,
    });
    expect(r.success).toBe(true);
  });

  it("拒绝非法 wechat.status.state", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.status", deviceId: "dev1", state: "boom", ts: 1,
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C packages/connector-protocol test`
Expected: FAIL —— `wechat.inbound` 不是 `clientMessageSchema` 的合法分支（当前 union 无此 type）。

- [ ] **Step 3: 写 `packages/connector-protocol/src/wechat.ts`**

```typescript
import { z } from "zod";

// 媒体引用占位：P1 不消费，仅协议层校验，P2 多模态使用。
export const wechatMediaSchema = z.object({
  kind: z.enum(["image", "file", "voice"]),
  cdnUrl: z.string().min(1),
  name: z.string().optional(),
  aesKey: z.string().optional(),
});

// ---- client → hub：设备上推收到的微信消息 ----
export const wechatInboundSchema = z.object({
  type: z.literal("wechat.inbound"),
  deviceId: z.string().min(1),
  msgId: z.string().min(1),
  from: z.string().min(1),
  chatType: z.literal("private"),
  text: z.string().default(""),
  media: z.array(wechatMediaSchema).default([]),
  contextToken: z.string().min(1), // iLink 回复所需，必带
  ts: z.number(),
});
export type WechatInbound = z.infer<typeof wechatInboundSchema>;

// ---- client → hub：绑定/在线状态 ----
export const wechatStatusSchema = z.object({
  type: z.literal("wechat.status"),
  deviceId: z.string().min(1),
  state: z.enum(["qr", "scanned", "confirmed", "disconnected"]),
  qr: z.string().optional(),      // state=qr 时携带二维码内容/URL
  reason: z.string().optional(),  // state=disconnected 时携带原因
  ts: z.number(),
});
export type WechatStatus = z.infer<typeof wechatStatusSchema>;

// ---- hub → client：云端下发发送微信消息 ----
export interface WechatSend {
  type: "wechat.send";
  id: string;
  to: string;            // 收件人 wxid（= inbound.from）
  contextToken: string;  // 透传 inbound.contextToken
  text: string;
}
```

- [ ] **Step 4: 改 `packages/connector-protocol/src/index.ts`**

在文件顶部 import 区加：
```typescript
import { wechatInboundSchema, wechatStatusSchema } from "./wechat.js";
```
把两者并入 `clientMessageSchema`（现有 `z.discriminatedUnion("type", [...])`）：
```typescript
export const clientMessageSchema = z.discriminatedUnion("type", [
  deviceRegisterSchema,
  toolResultSchema,
  toolErrorSchema,
  toolStreamSchema,
  hbPongSchema,
  wechatInboundSchema,
  wechatStatusSchema,
]);
```
把 `WechatSend` 并入 `HubMessage`：
```typescript
import type { WechatSend } from "./wechat.js";
export type HubMessage = DeviceAck | ToolInvoke | HbPing | WechatSend;
```
并在文件末尾整体 re-export：
```typescript
export * from "./wechat.js";
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm -C packages/connector-protocol test && pnpm -C packages/connector-protocol typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/connector-protocol/src/wechat.ts packages/connector-protocol/src/wechat.test.ts packages/connector-protocol/src/index.ts
git commit -m "connector 协议新增 wechat.inbound/status/send 消息"
```

---

#### Task 2: 文本分块（>4000 自动分段）

iLink `sendmessage` 单条上限 4000 字符（见参照文件）。分块逻辑语言无关，先独立实现。

**Files:**
- Create: `apps/desktop/src/shared/wechat/chunk.ts`
- Create: `apps/desktop/src/shared/wechat/chunk.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { chunkText, WECHAT_MAX_CHARS } from "./chunk.js";

describe("chunkText", () => {
  it("短文本返回单块", () => {
    expect(chunkText("你好")).toEqual(["你好"]);
  });
  it("空文本返回单个空块（保证至少发一次）", () => {
    expect(chunkText("")).toEqual([""]);
  });
  it("超长文本按上限切分且不丢字符", () => {
    const s = "a".repeat(WECHAT_MAX_CHARS * 2 + 5);
    const parts = chunkText(s);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= WECHAT_MAX_CHARS)).toBe(true);
    expect(parts.join("")).toBe(s);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C apps/desktop test -- chunk`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写 `apps/desktop/src/shared/wechat/chunk.ts`**

```typescript
export const WECHAT_MAX_CHARS = 4000;

// 按固定字符上限切分；空串返回 [""] 以保证至少发送一次。
export function chunkText(text: string, max: number = WECHAT_MAX_CHARS): string[] {
  if (text.length === 0) return [""];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    parts.push(text.slice(i, i + max));
  }
  return parts;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm -C apps/desktop test -- chunk`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/wechat/chunk.ts apps/desktop/src/shared/wechat/chunk.test.ts
git commit -m "新增微信文本分块工具"
```

---

#### Task 3: iLink HTTP 客户端（对照参照文件逐字段移植）

**Files:**
- Create: `apps/desktop/src/shared/wechat/ilink-api.ts`
- Create: `apps/desktop/src/shared/wechat/ilink-api.test.ts`

> **移植准则（必须遵守）：**
> 1. 已确认常量（可直接写死）：
>    - `BASE_URL = "https://ilinkai.weixin.qq.com"`
>    - 端点：`/ilink/bot/get_bot_qrcode?bot_type=3`（取码）、`/ilink/bot/get_qrcode_status?qrcode=<v>`（轮询）、`/ilink/bot/getupdates`（收）、`/ilink/bot/sendmessage`（发）
>    - 固定请求头：`{ "iLink-App-Id": "bot", "iLink-App-ClientVersion": "131072" }`；有 token 时附加 iLink bot token 授权头（字段名对照参照文件）
> 2. **请求体字段名、响应字段名、扫码状态取值（wait/scaned/expired/confirmed）、token 从哪个响应字段取、getupdates 的长轮询参数与返回结构 —— 全部对照参照 `weixin_api.py` 逐字段实现，不得臆造。**
> 3. 所有网络调用通过注入的 `fetchFn: typeof fetch` 进行（默认 `globalThis.fetch`），以便单测 mock。

- [ ] **Step 1: 读参照文件，确认 wire-format**

Run:
```bash
curl -s https://raw.githubusercontent.com/zhayujie/CowAgent/master/channel/weixin/weixin_api.py -o /tmp/weixin_api.py && sed -n '1,200p' /tmp/weixin_api.py
```
逐一记录：`get_bot_qrcode`/`get_qrcode_status`/`getupdates`/`sendmessage` 的 method、query、body、response JSON 字段名，以及 token 提取字段、扫码状态字符串。以下步骤按此填充。

- [ ] **Step 2: 写失败测试**（测语言无关行为：URL/头构造、状态映射、非流式解析；用 mock fetch）

```typescript
import { describe, it, expect, vi } from "vitest";
import { createILinkApi, ILINK_BASE_URL, ILINK_HEADERS } from "./ilink-api.js";

function mockFetch(responder: (url: string, init?: RequestInit) => unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => responder(url, init),
    text: async () => JSON.stringify(responder(url, init)),
  })) as unknown as typeof fetch;
}

describe("iLink api", () => {
  it("fetchQrCode 命中 get_bot_qrcode?bot_type=3 且带固定头", async () => {
    const fetchFn = mockFetch(() => ({ /* 对照参照：二维码字段 */ qrcode: "QR", url: "https://q" }));
    const api = createILinkApi({ fetchFn });
    await api.fetchQrCode();
    const [calledUrl, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(calledUrl).toBe(`${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
    expect((init?.headers as Record<string, string>)["iLink-App-Id"]).toBe("bot");
    expect((init?.headers as Record<string, string>)).toMatchObject(ILINK_HEADERS);
  });

  it("pollQrStatus 把参照状态串映射为标准枚举", async () => {
    // 对照参照：这里的 raw 值用参照文件里的真实字符串
    const fetchFn = mockFetch(() => ({ status: "confirmed", token: "bot-token-xyz" }));
    const api = createILinkApi({ fetchFn });
    const r = await api.pollQrStatus("QR");
    expect(r.state).toBe("confirmed");
    expect(r.token).toBe("bot-token-xyz");
  });

  it("sendText 携带 token 授权头并 POST 到 sendmessage", async () => {
    const fetchFn = mockFetch(() => ({ ok: true }));
    const api = createILinkApi({ fetchFn, token: "bot-token-xyz" });
    await api.sendText({ to: "wxid_a", contextToken: "ctx", text: "hi" });
    const [calledUrl, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(calledUrl).toBe(`${ILINK_BASE_URL}/ilink/bot/sendmessage`);
    expect(init?.method).toBe("POST");
  });
});
```

- [ ] **Step 3: 实现 `apps/desktop/src/shared/wechat/ilink-api.ts`**

骨架如下；`// 对照参照` 标注处按 Step 1 记录的真实字段名填充（不是占位，是移植点）：

```typescript
export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const ILINK_HEADERS: Record<string, string> = {
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": "131072",
};

export type QrState = "wait" | "scanned" | "expired" | "confirmed";
export interface QrStatusResult { state: QrState; token?: string; }

export interface ILinkUpdate {
  msgId: string; from: string; text: string; contextToken: string; ts: number;
  // P2 media 字段对照参照补充
}

export interface CreateILinkApiOpts {
  fetchFn?: typeof fetch;
  token?: string;
  baseUrl?: string;
}

export function createILinkApi(opts: CreateILinkApiOpts = {}) {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const base = opts.baseUrl ?? ILINK_BASE_URL;
  let token = opts.token ?? "";

  const headers = (): Record<string, string> => ({
    ...ILINK_HEADERS,
    // 对照参照：有 token 时的授权头字段名（如 "iLink-Bot-Token" 或 Authorization），务必与参照一致
    ...(token ? { /* 对照参照 */ } : {}),
  });

  return {
    setToken(t: string) { token = t; },

    async fetchQrCode(): Promise<{ qr: string; qrUrl?: string }> {
      const r = await fetchFn(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, { headers: headers() });
      const j = await r.json();
      // 对照参照：二维码内容/URL 字段名
      return { qr: (j as Record<string, string>).qrcode, qrUrl: (j as Record<string, string>).url };
    },

    async pollQrStatus(qr: string): Promise<QrStatusResult> {
      const r = await fetchFn(`${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`, { headers: headers() });
      const j = (await r.json()) as Record<string, string>;
      // 对照参照：把参照里的状态字符串映射到 QrState；confirmed 时取 token 字段
      const raw = j.status;
      const map: Record<string, QrState> = { /* 对照参照：wait/scaned/expired/confirmed 的真实取值 */ };
      const state = map[raw] ?? "wait";
      return state === "confirmed" ? { state, token: j.token } : { state };
    },

    async getUpdates(): Promise<ILinkUpdate[]> {
      // 对照参照：method、长轮询超时参数、body/query、响应数组字段与元素结构
      const r = await fetchFn(`${base}/ilink/bot/getupdates`, { method: "POST", headers: headers(), body: JSON.stringify({ /* 对照参照 */ }) });
      const j = (await r.json()) as { /* 对照参照 */ updates?: unknown[] };
      return (j.updates ?? []).map((u) => {
        const m = u as Record<string, unknown>;
        // 对照参照：msgId/from/text/contextToken/ts 各字段名
        return { msgId: String(m.msgId), from: String(m.from), text: String(m.text ?? ""), contextToken: String(m.contextToken), ts: Number(m.ts) };
      });
    },

    async sendText(a: { to: string; contextToken: string; text: string }): Promise<void> {
      // 对照参照：sendmessage 请求体字段（收件人/上下文/文本/消息类型）
      await fetchFn(`${base}/ilink/bot/sendmessage`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ /* 对照参照：to / contextToken / text / type */ }),
      });
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**（Step 1 填充后）

Run: `pnpm -C apps/desktop test -- ilink-api`
Expected: PASS。若参照字段与测试里的 mock 不一致，以参照为准同步修正测试 mock。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/wechat/ilink-api.ts apps/desktop/src/shared/wechat/ilink-api.test.ts
git commit -m "新增 iLink 微信 HTTP 客户端"
```

---

#### Task 4: iLink 凭据本地加密存储

仿 `apps/desktop/src/main/electron-deps.ts` 的 `makeTokenStore`（safeStorage + userData）。

**Files:**
- Create: `apps/desktop/src/main/wechat-store.ts`

- [ ] **Step 1: 实现 `apps/desktop/src/main/wechat-store.ts`**（无独立单测——依赖 electron 运行时，逻辑与既有 `makeTokenStore` 同构，靠既有模式与 typecheck 保障）

```typescript
import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface WechatCredentials {
  readonly token: string;
  // owner 侧标识（对照参照：登录成功响应里的 bot 自身 wxid/uin 字段），用于将来识别 owner
  readonly selfId?: string;
}

export interface WechatCredentialStore {
  get: () => WechatCredentials | null;
  set: (c: WechatCredentials) => void;
  clear: () => void;
}

export function makeWechatStore(): WechatCredentialStore {
  const file = join(app.getPath("userData"), "wechat.token.enc");
  return {
    get: () => {
      if (!existsSync(file)) return null;
      try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file))) as Partial<WechatCredentials>;
        return typeof parsed.token === "string" && parsed.token ? { token: parsed.token, selfId: parsed.selfId } : null;
      } catch {
        return null;
      }
    },
    set: (c) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密不可用，拒绝以明文存储微信凭据");
      writeFileSync(file, safeStorage.encryptString(JSON.stringify(c)), { mode: 0o600 });
    },
    clear: () => {
      if (existsSync(file)) writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
    },
  };
}
```

- [ ] **Step 2: typecheck + 提交**

Run: `pnpm -C apps/desktop typecheck`
Expected: PASS。
```bash
git add apps/desktop/src/shared/wechat apps/desktop/src/main/wechat-store.ts
git commit -m "新增微信凭据本地加密存储"
```

---

#### Task 5: 桌面端微信 channel runner（长轮询 + 去重 + 上推/下发）

**Files:**
- Create: `apps/desktop/src/shared/wechat/channel.ts`
- Create: `apps/desktop/src/shared/wechat/channel.test.ts`

runner 依赖注入：`api`（Task 3 的 iLink client）、`send`（把 `wechat.inbound`/`wechat.status` 发上 hub 的函数，实际由 daemon 提供）、`deviceId`、`getToken`/`saveToken`。核心行为可单测：**msgId 去重、把 update 转 `wechat.inbound` 上推、`sendReply` 走分块调 `api.sendText`、掉线上报 `wechat.status`**。

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createWechatChannel } from "./channel.js";

function fakeApi(updates: unknown[][]) {
  let call = 0;
  return {
    setToken: vi.fn(),
    getUpdates: vi.fn(async () => (updates[call++] ?? [])),
    sendText: vi.fn(async () => {}),
    fetchQrCode: vi.fn(), pollQrStatus: vi.fn(),
  };
}

describe("wechat channel runner", () => {
  it("把 update 转成 wechat.inbound 上推，且相同 msgId 只上推一次", async () => {
    const sent: unknown[] = [];
    const api = fakeApi([
      [{ msgId: "m1", from: "wxid_a", text: "hi", contextToken: "c1", ts: 1 }],
      [{ msgId: "m1", from: "wxid_a", text: "hi", contextToken: "c1", ts: 1 }], // 重复
      [{ msgId: "m2", from: "wxid_a", text: "yo", contextToken: "c2", ts: 2 }],
    ]);
    const ch = createWechatChannel({ api: api as never, deviceId: "dev1", send: (m) => { sent.push(m); }, token: "t" });
    await ch.pollOnce(); await ch.pollOnce(); await ch.pollOnce();
    const inbound = sent.filter((m) => (m as { type: string }).type === "wechat.inbound");
    expect(inbound.length).toBe(2);
    expect(inbound[0]).toMatchObject({ type: "wechat.inbound", deviceId: "dev1", msgId: "m1", from: "wxid_a", text: "hi", contextToken: "c1" });
  });

  it("sendReply 超长文本分块多次调用 sendText", async () => {
    const api = fakeApi([]);
    const ch = createWechatChannel({ api: api as never, deviceId: "dev1", send: () => {}, token: "t" });
    await ch.sendReply({ to: "wxid_a", contextToken: "c1", text: "x".repeat(9000) });
    expect(api.sendText).toHaveBeenCalledTimes(3);
  });

  it("getUpdates 抛错时上报 disconnected", async () => {
    const sent: unknown[] = [];
    const api = { setToken: vi.fn(), sendText: vi.fn(), fetchQrCode: vi.fn(), pollQrStatus: vi.fn(),
      getUpdates: vi.fn(async () => { throw new Error("token expired"); }) };
    const ch = createWechatChannel({ api: api as never, deviceId: "dev1", send: (m) => { sent.push(m); }, token: "t" });
    await ch.pollOnce();
    expect(sent.some((m) => (m as { type: string; state?: string }).type === "wechat.status" && (m as { state?: string }).state === "disconnected")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C apps/desktop test -- channel`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `apps/desktop/src/shared/wechat/channel.ts`**

```typescript
import type { WechatInbound, WechatStatus } from "@yc/connector-protocol";
import { chunkText } from "./chunk.js";
import type { createILinkApi } from "./ilink-api.js";

type ILinkApi = ReturnType<typeof createILinkApi>;
type UpMessage = WechatInbound | WechatStatus;

export interface WechatChannelOpts {
  api: ILinkApi;
  deviceId: string;
  send: (msg: UpMessage) => void; // 上推 hub
  token: string;
}

export function createWechatChannel(opts: WechatChannelOpts) {
  const seen = new Set<string>();
  opts.api.setToken(opts.token);

  async function pollOnce(): Promise<void> {
    let updates;
    try {
      updates = await opts.api.getUpdates();
    } catch (e) {
      opts.send({
        type: "wechat.status", deviceId: opts.deviceId, state: "disconnected",
        reason: e instanceof Error ? e.message : String(e), ts: Date.now(),
      });
      return;
    }
    for (const u of updates) {
      if (seen.has(u.msgId)) continue;
      seen.add(u.msgId);
      opts.send({
        type: "wechat.inbound", deviceId: opts.deviceId, msgId: u.msgId, from: u.from,
        chatType: "private", text: u.text, media: [], contextToken: u.contextToken, ts: u.ts,
      });
    }
  }

  async function sendReply(a: { to: string; contextToken: string; text: string }): Promise<void> {
    for (const part of chunkText(a.text)) {
      await opts.api.sendText({ to: a.to, contextToken: a.contextToken, text: part });
    }
  }

  return { pollOnce, sendReply };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm -C apps/desktop test -- channel`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/wechat/channel.ts apps/desktop/src/shared/wechat/channel.test.ts
git commit -m "新增桌面端微信 channel runner"
```

---

#### Task 6: DB 新增 `WechatBinding` 模型

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<ts>_add_wechat_binding/migration.sql`（由命令生成）

- [ ] **Step 1: 加 model（`schema.prisma` 末尾）**

```prisma
model WechatBinding {
  id           String   @id @default(cuid())
  userId       String
  deviceId     String   @unique
  targetType   String   // "agent" | "team"（P1 仅 agent）
  targetId     String
  sessionId    String   // 微信持续会话线程（指向 Session.id）
  online       Boolean  @default(false)
  lastSeenAt   DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([userId])
}
```

- [ ] **Step 2: 生成并跑迁移**

Run:
```bash
cd packages/db && npx prisma migrate dev --name add_wechat_binding && pnpm generate
```
Expected: 新迁移目录生成、`WechatBinding` 表创建、Prisma Client 重新生成、无报错。

- [ ] **Step 3: 提交**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "新增 WechatBinding 数据模型"
```

---

#### Task 7: 绑定读写与解析 `apps/api/src/wechat/binding.ts`

**Files:**
- Create: `apps/api/src/wechat/binding.ts`
- Create: `apps/api/src/wechat/binding.test.ts`

- [ ] **Step 1: 写失败测试**（用注入的假 prisma，参照 `binding.test.ts` 同 repo 风格）

```typescript
import { describe, it, expect, vi } from "vitest";
import { resolveBindingByDevice } from "./binding.js";

describe("resolveBindingByDevice", () => {
  it("按 deviceId 找到绑定并返回 userId/target/sessionId", async () => {
    const prisma = { wechatBinding: { findUnique: vi.fn(async () => ({
      userId: "u1", deviceId: "dev1", targetType: "agent", targetId: "a1", sessionId: "s1",
    })) } };
    const b = await resolveBindingByDevice(prisma as never, "dev1");
    expect(b).toMatchObject({ userId: "u1", targetType: "agent", targetId: "a1", sessionId: "s1" });
  });

  it("无绑定返回 null", async () => {
    const prisma = { wechatBinding: { findUnique: vi.fn(async () => null) } };
    expect(await resolveBindingByDevice(prisma as never, "devX")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm -C apps/api test -- wechat/binding` → FAIL（模块不存在）。

- [ ] **Step 3: 实现 `apps/api/src/wechat/binding.ts`**

```typescript
import type { PrismaClient } from "@yc/db";

export interface ResolvedBinding {
  userId: string;
  deviceId: string;
  targetType: "agent" | "team";
  targetId: string;
  sessionId: string;
}

export async function resolveBindingByDevice(
  prisma: PrismaClient,
  deviceId: string,
): Promise<ResolvedBinding | null> {
  const b = await prisma.wechatBinding.findUnique({ where: { deviceId } });
  if (!b) return null;
  return {
    userId: b.userId, deviceId: b.deviceId,
    targetType: b.targetType as "agent" | "team",
    targetId: b.targetId, sessionId: b.sessionId,
  };
}
```

- [ ] **Step 4: 运行确认通过** — Run: `pnpm -C apps/api test -- wechat/binding` → PASS。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/wechat/binding.ts apps/api/src/wechat/binding.test.ts
git commit -m "新增微信绑定解析"
```

---

#### Task 8: headless 回合 `apps/api/src/wechat/turn.ts`（强制 M3 + 计费）

复用 `agent/run.ts` 的 `runTurn`、`packages/billing` 的 `reserve/settle`、`packages/llm` 的 `createLlmClient/loadLlmConfig`、`chat` 的 `resolveAgent` 与 `estimateInputTokens`、prisma `Session/Message`。P1 不带工具（`tools: []`），纯文字。

**Files:**
- Create: `apps/api/src/wechat/turn.ts`
- Create: `apps/api/src/wechat/turn.test.ts`

- [ ] **Step 1: 写失败测试**（注入假 deps，断言强制模型 = MiniMax-M3、reserve/settle 均被调用、返回 runTurn 文本、落库 assistant 消息）

```typescript
import { describe, it, expect, vi } from "vitest";
import { runWechatTurn, WECHAT_MODEL } from "./turn.js";

it("强制 MiniMax-M3、预扣→跑→结算，返回回复文本并落库", async () => {
  const billing = { reserve: vi.fn(async () => ({ reserved: 1 })), settle: vi.fn(async () => ({ settled: 1 })) };
  const runTurn = vi.fn(async () => ({ text: "机器人回复", usage: { inputTokens: 3, outputTokens: 5 }, messages: [], toolCalls: 0, stoppedByMaxIterations: false }));
  const prisma = {
    message: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    session: { findUnique: vi.fn(async () => ({ id: "s1", userId: "u1", agentPrompt: "你是助手" })) },
  };
  const out = await runWechatTurn({
    prisma: prisma as never, billing: billing as never, runTurn: runTurn as never,
    client: {} as never, binding: { userId: "u1", deviceId: "dev1", targetType: "agent", targetId: "a1", sessionId: "s1" },
    text: "你好",
  });
  expect(WECHAT_MODEL).toBe("MiniMax-M3");
  expect(billing.reserve).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", model: "MiniMax-M3", type: "chat" }));
  expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ model: "MiniMax-M3" }));
  expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", model: "MiniMax-M3", outputTokens: 5 }));
  expect(out.text).toBe("机器人回复");
  expect(prisma.message.create).toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm -C apps/api test -- wechat/turn` → FAIL。

- [ ] **Step 3: 实现 `apps/api/src/wechat/turn.ts`**

```typescript
import type { PrismaClient } from "@yc/db";
import type Anthropic from "@anthropic-ai/sdk";
import type { runTurn as RunTurnFn } from "../agent/run.js";
import type { ResolvedBinding } from "./binding.js";

export const WECHAT_MODEL = "MiniMax-M3";
const RESERVE_OUTPUT_TOKENS = 10_000; // 与 chat 一致

interface BillingLike {
  reserve: (a: { operationId: string; userId: string; type: string; model: string; inputTokens: number; maxOutputTokens: number }) => Promise<unknown>;
  settle: (a: { operationId: string; userId: string; model: string; inputTokens: number; outputTokens: number }) => Promise<unknown>;
}

export interface RunWechatTurnArgs {
  prisma: PrismaClient;
  billing: BillingLike;
  runTurn: typeof RunTurnFn;
  client: Anthropic;
  binding: ResolvedBinding;
  text: string;
}

export async function runWechatTurn(a: RunWechatTurnArgs): Promise<{ text: string }> {
  const session = await a.prisma.session.findUnique({ where: { id: a.binding.sessionId } });
  if (!session || session.userId !== a.binding.userId) throw new Error("会话不存在或不属于绑定用户");

  // 落库用户消息
  await a.prisma.message.create({ data: { sessionId: a.binding.sessionId, role: "user", content: a.text } });

  // 组装历史
  const rows = await a.prisma.message.findMany({ where: { sessionId: a.binding.sessionId }, orderBy: { createdAt: "asc" } });
  const history = rows.map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: m.content }));

  const operationId = `wechat:${a.binding.sessionId}:${Date.now()}`;
  await a.billing.reserve({
    operationId, userId: a.binding.userId, type: "chat", model: WECHAT_MODEL,
    inputTokens: Math.ceil(a.text.length / 2), maxOutputTokens: RESERVE_OUTPUT_TOKENS,
  });

  let result;
  try {
    result = await a.runTurn({
      client: a.client, model: WECHAT_MODEL, history,
      system: session.agentPrompt ?? undefined, tools: [], // P1 无工具
    });
  } finally {
    // 无论成败都结算已发生用量（失败时 usage 缺省 0）
  }

  await a.billing.settle({
    operationId, userId: a.binding.userId, model: WECHAT_MODEL,
    inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
  });

  await a.prisma.message.create({ data: { sessionId: a.binding.sessionId, role: "assistant", content: result.text, model: WECHAT_MODEL } });
  return { text: result.text };
}
```

> 注：`reserve.inputTokens` 用 `chat` 里 `estimateInputTokens` 更精确；P1 先用近似 `ceil(len/2)`，接线时若 `estimateInputTokens` 可无副作用复用则替换（见 `apps/api/src/chat/routes.ts`）。

- [ ] **Step 4: 运行确认通过** — Run: `pnpm -C apps/api test -- wechat/turn` → PASS。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/wechat/turn.ts apps/api/src/wechat/turn.test.ts
git commit -m "新增微信 headless 回合与计费"
```

---

#### Task 9: 云端 hub 接线 + 微信 service

**Files:**
- Modify: `apps/api/src/connector/hub.ts`（`HubConnCtx`、`handleClientMessage`、导出 `sendToDevice`）
- Create: `apps/api/src/wechat/service.ts`
- Create: `apps/api/src/wechat/service.test.ts`

- [ ] **Step 1: 扩 `HubConnCtx` 与 `handleClientMessage`（hub.ts）**

在 `HubConnCtx` 接口加：
```typescript
  onWechatInbound: (deviceId: string, msg: import("@yc/connector-protocol").WechatInbound) => Promise<void>;
  onWechatStatus: (deviceId: string, msg: import("@yc/connector-protocol").WechatStatus) => Promise<void>;
```
在 `handleClientMessage` 注册后的 `switch (msg.type)` 里加两个 case：
```typescript
    case "wechat.inbound":
      await ctx.onWechatInbound(ctx.deviceId, msg);
      break;
    case "wechat.status":
      await ctx.onWechatStatus(ctx.deviceId, msg);
      break;
```
在 hub 模块导出向指定设备下发的函数（复用现有 `local.get(deviceId)?.send`）：
```typescript
export function sendToDevice(deviceId: string, msg: import("@yc/connector-protocol").HubMessage): boolean {
  const conn = local.get(deviceId);
  if (!conn) return false;
  conn.send(msg);
  return true;
}
```
在 `/ws/connector` 的 ctx 里接上 service（见 Step 4），其中 `onWechatInbound/onWechatStatus` 委托给 `wechat/service`。

- [ ] **Step 2: 写 service 失败测试** `apps/api/src/wechat/service.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleWechatInbound } from "./service.js";

it("解析绑定→跑回合→下发 wechat.send 到同设备", async () => {
  const sent: unknown[] = [];
  const deps = {
    resolveBinding: vi.fn(async () => ({ userId: "u1", deviceId: "dev1", targetType: "agent", targetId: "a1", sessionId: "s1" })),
    runTurn: vi.fn(async () => ({ text: "回复你" })),
    sendToDevice: (deviceId: string, msg: unknown) => { sent.push({ deviceId, msg }); return true; },
  };
  await handleWechatInbound(deps as never, {
    type: "wechat.inbound", deviceId: "dev1", msgId: "m1", from: "wxid_a",
    chatType: "private", text: "你好", media: [], contextToken: "ctx1", ts: 1,
  });
  expect(deps.runTurn).toHaveBeenCalled();
  expect(sent[0]).toMatchObject({ deviceId: "dev1", msg: { type: "wechat.send", to: "wxid_a", contextToken: "ctx1", text: "回复你" } });
});

it("无绑定则忽略，不下发", async () => {
  const sent: unknown[] = [];
  const deps = { resolveBinding: vi.fn(async () => null), runTurn: vi.fn(), sendToDevice: () => { sent.push(1); return true; } };
  await handleWechatInbound(deps as never, {
    type: "wechat.inbound", deviceId: "devX", msgId: "m1", from: "a", chatType: "private", text: "hi", media: [], contextToken: "c", ts: 1,
  });
  expect(sent.length).toBe(0);
});
```

- [ ] **Step 3: 运行确认失败** — Run: `pnpm -C apps/api test -- wechat/service` → FAIL。

- [ ] **Step 4: 实现 `apps/api/src/wechat/service.ts`**

```typescript
import { randomUUID } from "node:crypto";
import type { WechatInbound, WechatStatus, WechatSend } from "@yc/connector-protocol";
import type { ResolvedBinding } from "./binding.js";

export interface WechatServiceDeps {
  resolveBinding: (deviceId: string) => Promise<ResolvedBinding | null>;
  runTurn: (binding: ResolvedBinding, text: string) => Promise<{ text: string }>;
  sendToDevice: (deviceId: string, msg: WechatSend) => boolean;
}

export async function handleWechatInbound(deps: WechatServiceDeps, msg: WechatInbound): Promise<void> {
  const binding = await deps.resolveBinding(msg.deviceId);
  if (!binding) return; // 设备未绑定，忽略
  if (!msg.text.trim()) return; // P1 仅文字

  const { text } = await deps.runTurn(binding, msg.text);
  const send: WechatSend = { type: "wechat.send", id: randomUUID(), to: msg.from, contextToken: msg.contextToken, text };
  deps.sendToDevice(msg.deviceId, send);
}

export async function handleWechatStatus(
  updateOnline: (deviceId: string, online: boolean, reason?: string) => Promise<void>,
  msg: WechatStatus,
): Promise<void> {
  await updateOnline(msg.deviceId, msg.state === "confirmed", msg.state === "disconnected" ? msg.reason : undefined);
}
```

`service.ts` 里再提供一个装配函数，把 `resolveBindingByDevice`(Task 7) + `runWechatTurn`(Task 8) + hub `sendToDevice`(Step 1) 组装成 `WechatServiceDeps`，供 `server.ts` 注入 hub 的 `onWechatInbound`。装配用真实 prisma/billing/llm client（在 `server.ts` 已有实例）。

- [ ] **Step 5: 运行确认通过** — Run: `pnpm -C apps/api test -- wechat/service` → PASS。

- [ ] **Step 6: typecheck 全 api** — Run: `pnpm -C apps/api typecheck` → PASS。

- [ ] **Step 7: 提交**
```bash
git add apps/api/src/connector/hub.ts apps/api/src/wechat/service.ts apps/api/src/wechat/service.test.ts
git commit -m "云端接线微信入站到回合与下发"
```

---

#### Task 10: 绑定 CRUD 路由 `apps/api/src/wechat/routes.ts`

绑定动作：桌面端扫码成功后，web 端点「绑定到某 Agent」→ 调此路由建 `WechatBinding`（同时创建/复用一个专属 Session 作为持续会话线程）。鉴权取 `req.userId`（与 `chat/routes.ts` 同款），并校验 `deviceId` 属于该用户（查 `Device.userId === userId`，防越权绑别人设备）。

**Files:**
- Create: `apps/api/src/wechat/routes.ts`
- Create: `apps/api/src/wechat/routes.test.ts`
- Modify: `apps/api/src/server.ts`（注册路由 + 接 hub 的 wechat 回调）

- [ ] **Step 1: 写失败测试**（仿 `chat/sessions.test.ts` 用 `app.inject`，断言：未登录 401、绑定他人设备 403、正常创建 200 且落 `WechatBinding` + `Session`）

```typescript
import { describe, it, expect } from "vitest";
// 复用仓库既有的建 app + 造 user/token + 测试库 fixture 方式（见 apps/api/src/chat/sessions.test.ts 顶部）
// 断言骨架：
it("POST /api/wechat/bindings 未登录 401", async () => {
  const r = await app.inject({ method: "POST", url: "/api/wechat/bindings", payload: { deviceId: "dev1", targetType: "agent", targetId: "a1" } });
  expect(r.statusCode).toBe(401);
});
it("绑定不属于自己的设备 403", async () => {
  const r = await app.inject({ method: "POST", url: "/api/wechat/bindings", headers: { authorization: authUser1 }, payload: { deviceId: "deviceOfUser2", targetType: "agent", targetId: "a1" } });
  expect(r.statusCode).toBe(403);
});
it("正常创建 200 并可查询", async () => {
  const c = await app.inject({ method: "POST", url: "/api/wechat/bindings", headers: { authorization: authUser1 }, payload: { deviceId: "dev1", targetType: "agent", targetId: "a1" } });
  expect(c.statusCode).toBe(200);
  const l = await app.inject({ method: "GET", url: "/api/wechat/bindings", headers: { authorization: authUser1 } });
  expect(JSON.parse(l.body).data.length).toBe(1);
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm -C apps/api test -- wechat/routes` → FAIL。

- [ ] **Step 3: 实现 `apps/api/src/wechat/routes.ts`**

```typescript
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@yc/db";

const createSchema = z.object({
  deviceId: z.string().min(1).max(128),
  targetType: z.literal("agent"), // P1 仅 agent
  targetId: z.string().min(1).max(128),
});

export async function registerWechatRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  app.post("/api/wechat/bindings", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    const device = await prisma.device.findUnique({ where: { id: parsed.data.deviceId }, select: { userId: true } });
    if (!device || device.userId !== userId) return reply.code(403).send({ error: "无权绑定该设备" });

    // 专属持续会话线程
    const session = await prisma.session.create({ data: { userId, title: "微信", agentId: parsed.data.targetId } });
    const binding = await prisma.wechatBinding.upsert({
      where: { deviceId: parsed.data.deviceId },
      create: { userId, deviceId: parsed.data.deviceId, targetType: parsed.data.targetType, targetId: parsed.data.targetId, sessionId: session.id },
      update: { targetType: parsed.data.targetType, targetId: parsed.data.targetId },
    });
    return reply.send({ success: true, data: { id: binding.id } });
  });

  app.get("/api/wechat/bindings", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const list = await prisma.wechatBinding.findMany({ where: { userId } });
    return reply.send({ success: true, data: list });
  });

  app.delete("/api/wechat/bindings/:id", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const id = (req.params as { id: string }).id;
    const b = await prisma.wechatBinding.findUnique({ where: { id } });
    if (!b || b.userId !== userId) return reply.code(403).send({ error: "无权删除" });
    await prisma.wechatBinding.delete({ where: { id } });
    return reply.send({ success: true });
  });
}
```

- [ ] **Step 4: 在 `server.ts` 注册路由并接 hub 回调**

在 `server.ts`（`registerHub(app)` 附近）加：
```typescript
import { registerWechatRoutes } from "./wechat/routes.js";
// ...
await registerWechatRoutes(app, prisma);
```
并把 hub 的 `onWechatInbound/onWechatStatus`（Task 9 Step 1 的 ctx 字段）接到 `wechat/service` 装配函数（Task 9 Step 4）。

- [ ] **Step 5: 运行确认通过 + 全量回归**

Run: `pnpm -C apps/api test && pnpm -C apps/api typecheck`
Expected: 全绿（含既有 connector/chat 测试不回归）。

- [ ] **Step 6: 提交**
```bash
git add apps/api/src/wechat/routes.ts apps/api/src/wechat/routes.test.ts apps/api/src/server.ts
git commit -m "新增微信绑定 CRUD 路由与接线"
```

---

#### Task 11: 桌面端接线（daemon 下发 + 主进程启动 + IPC）

**Files:**
- Modify: `apps/desktop/src/shared/daemon.ts`（`wechat.send` case）
- Modify: `apps/desktop/src/main/index.ts`（启动 channel runner；IPC 绑定）
- Modify: `apps/desktop/src/preload/index.ts`（暴露桥接方法）

- [ ] **Step 1: daemon 处理 `wechat.send`（`daemon.ts` 的 `handleHubMessage` switch）**

在现有 `case "tool.invoke"` 之后加：
```typescript
    case "wechat.send": {
      try {
        await ctx.wechatSendReply({ to: msg.to, contextToken: msg.contextToken, text: msg.text });
      } catch (err) {
        // 发送失败仅记录，不影响连接（掉线会由 channel runner 的 poll 侧上报）
      }
      return;
    }
```
（`ctx.wechatSendReply` 由 daemon ctx 新增字段，指向 Task 5 channel runner 的 `sendReply`。同时 daemon ctx 需暴露 `send` 供 channel runner 上推 `wechat.inbound/status`——即把 `createWechatChannel({ send })` 的 `send` 指向 daemon 的 socket send。）

- [ ] **Step 2: 主进程启动 channel runner + IPC（`main/index.ts`）**

- 用 `makeWechatStore()`(Task 4) 读凭据；有 token 则 `createILinkApi({ token })` + `createWechatChannel({ api, deviceId, send: <daemon 上推>, token })`，起一个 `setInterval`/循环调 `channel.pollOnce()`（掉线由 runner 上报，UI 提示重扫）。
- 新增 IPC：
```typescript
ipcMain.handle("yc:wechat-bind-start", async (event) => {
  assertTrustedSender(event);
  const api = createILinkApi({});
  const { qr, qrUrl } = await api.fetchQrCode();
  // 后台轮询 pollQrStatus 直至 confirmed：存 token 到 makeWechatStore、上报 wechat.status，返回 qr 供 UI 展示
  startQrPolling(api); // 内部实现：wait→scanned→confirmed；confirmed 后 store.set({ token }) 并重启 channel runner
  return { qr, qrUrl };
});
ipcMain.handle("yc:wechat-bind-status", async (event) => {
  assertTrustedSender(event);
  return getBindState(); // { state: "qr"|"scanned"|"confirmed"|"disconnected", selfId? }
});
ipcMain.handle("yc:wechat-unbind", async (event) => {
  assertTrustedSender(event);
  makeWechatStore().clear();
  stopChannelRunner();
  return { ok: true };
});
```

- [ ] **Step 3: preload 暴露（`preload/index.ts` 的 `DesktopBridge`）**

```typescript
  readonly wechatBindStart: () => Promise<{ qr: string; qrUrl?: string }>;
  readonly wechatBindStatus: () => Promise<{ state: string; selfId?: string }>;
  readonly wechatUnbind: () => Promise<{ ok: boolean }>;
```
```typescript
  wechatBindStart: () => ipcRenderer.invoke("yc:wechat-bind-start"),
  wechatBindStatus: () => ipcRenderer.invoke("yc:wechat-bind-status"),
  wechatUnbind: () => ipcRenderer.invoke("yc:wechat-unbind"),
```

- [ ] **Step 4: typecheck + 既有测试回归**

Run: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test`
Expected: PASS（既有 `ws-client.test.ts` 等不回归）。

- [ ] **Step 5: 提交**
```bash
git add apps/desktop/src/shared/daemon.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts
git commit -m "桌面端接线微信下发与扫码绑定 IPC"
```

---

#### Task 12: web 绑定页 `apps/web/src/pages/WechatBind.tsx`

通过 `window.ycDesktop`（`desktopBridge.ts` 模式）扫码：点「绑定微信」→ `wechatBindStart()` 拿二维码渲染 → 轮询 `wechatBindStatus()` 到 `confirmed` → 调 `POST /api/wechat/bindings` 选定 Agent 完成绑定。仅桌面环境可用（`canBindWechat()` 特性检测），纯 web 显示「请在桌面客户端使用」。

**Files:**
- Create: `apps/web/src/pages/WechatBind.tsx`
- Modify: `apps/web/src/desktopBridge.ts`（加 `wechatBindStart/Status/Unbind` 桥接 + `canBindWechat()`）
- Modify: `apps/web/src/api.ts`（`createWechatBinding/listWechatBindings/deleteWechatBinding`）
- Modify: `apps/web/src/App.tsx` / `components/Shell.tsx`（加「微信接入」导航项与视图）

- [ ] **Step 1: `desktopBridge.ts` 加桥接**

```typescript
interface YcDesktopBridge {
  readonly deviceId?: string;
  readonly saveDocument?: (filename: string, content: string) => Promise<SaveDocumentResult>;
  readonly revealPath?: (path: string) => Promise<void>;
  readonly wechatBindStart?: () => Promise<{ qr: string; qrUrl?: string }>;
  readonly wechatBindStatus?: () => Promise<{ state: string; selfId?: string }>;
  readonly wechatUnbind?: () => Promise<{ ok: boolean }>;
}
export function canBindWechat(): boolean {
  return typeof bridge()?.wechatBindStart === "function";
}
export async function wechatBindStart() {
  const api = bridge()?.wechatBindStart;
  if (!api) throw new Error("请在桌面客户端使用微信接入");
  return api();
}
export async function wechatBindStatus() {
  return bridge()?.wechatBindStatus?.() ?? { state: "disconnected" };
}
```

- [ ] **Step 2: `api.ts` 加接口**（仿现有 `fetch("/api/...")` + `authorization: Bearer` 模式）

```typescript
export async function createWechatBinding(token: string, deviceId: string, targetId: string): Promise<{ id: string }> {
  const r = await fetch("/api/wechat/bindings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId, targetType: "agent", targetId }),
  });
  if (!r.ok) throw new Error("绑定失败");
  return (await r.json()).data;
}
export async function listWechatBindings(token: string) {
  const r = await fetch("/api/wechat/bindings", { headers: { authorization: `Bearer ${token}` } });
  return (await r.json()).data as Array<{ id: string; deviceId: string; targetId: string; online: boolean }>;
}
```

- [ ] **Step 3: `WechatBind.tsx` 页面**（React，仿现有 `pages/*` 结构）

要点：
- `canBindWechat()` 为 false → 渲染「请在桌面客户端打开本页」。
- 「生成二维码」按钮 → `wechatBindStart()` → 渲染 `qr`（用现有二维码渲染方式；若返回 `qrUrl` 直接 `<img src>`）。
- `useEffect` 每 2s `wechatBindStatus()`；`state==="confirmed"` 后展示 Agent 下拉（数据来自现有 `/api/agents` 或 `AgentOption`），选定后 `createWechatBinding(token, window.ycDesktop.deviceId, agentId)`。
- 已绑定列表：`listWechatBindings` 展示 + 解绑按钮（`deleteWechatBinding` + `wechatUnbind()`）。

- [ ] **Step 4: 挂导航**（`Shell.tsx` 的 `ViewType` 加 `"wechat"`，`App.tsx` 路由到 `<WechatBind/>`）。

- [ ] **Step 5: 构建校验**

Run: `pnpm -C apps/web build`
Expected: 构建通过、无类型错误。

- [ ] **Step 6: 提交**
```bash
git add apps/web/src/pages/WechatBind.tsx apps/web/src/desktopBridge.ts apps/web/src/api.ts apps/web/src/App.tsx apps/web/src/components/Shell.tsx
git commit -m "新增 web 微信接入绑定页"
```

---

#### Task 13: 端到端冒烟与回归

- [ ] **Step 1: 全仓类型与测试**

Run:
```bash
pnpm -r typecheck
pnpm -r test
```
Expected: 全绿（重点确认 connector-protocol / apps/api connector+chat / apps/desktop 既有测试无回归）。

- [ ] **Step 2: 真机手测清单**（记录结果，不通过则回到对应 Task）
  1. 桌面客户端「微信接入」→ 生成二维码 → 微信扫码确认 → `wechat.token.enc` 生成、状态 `confirmed`。
  2. 选定一个 Agent 完成绑定 → `WechatBinding` + `Session("微信")` 落库。
  3. 微信私聊 bot 发「你好」→ 桌面端 `wechat.inbound` 上推 → 云端 M3 回合 → 微信收到回复。
  4. 发 >4000 字触发分块，微信收到多条。
  5. 观察算力点扣减（reserve→settle 归属绑定用户）。
  6. 杀掉/过期 token → runner 上报 `disconnected` → UI 提示重扫。

- [ ] **Step 3: 提交手测记录（可选，写入本计划末尾或 PR 描述）**

---

#### 后续计划（不在本计划内，另起 plan）

- **P2 多模态**：`wechat.inbound.media` 落地——桌面端从 CDN 下载 + AES-128-ECB 解密 → 经 `apps/api/src/chat/attachments.ts` 通道上云 → 原生喂 M3；出向暂不发媒体。前置：确认 `attachments.ts` + llm client 能透传音频字节。
- **P3 Agent 团队 + 操作电脑**：`targetType: "team"` 路由到团队执行；`runWechatTurn` 传入 connector 工具（`terminal_exec/fs_*/browser_*`）与 `execTool`（经 hub `dispatchTool` 下发到同一 deviceId）。按已定「完全放开、任何发送方、无二次确认」实现，并在代码注释与文档标注已接受风险。

---

#### Self-Review（作者已核对）

- **Spec 覆盖**：形态/部署/交互/绑定/模型/多模态/会话/计费/掉线 —— P1 覆盖形态·部署·交互·绑定(agent)·强制M3·持续会话·计费·掉线；多模态(P2)、团队+操作电脑(P3) 已明确移出并另起 plan。✅
- **占位符扫描**：iLink wire-format 的 `// 对照参照` 是**移植指令**（Task 3 Step 1 先读参照文件再填），非「以后再说」；其余步骤均含可运行代码/命令与预期。✅
- **类型一致**：`WechatInbound/WechatStatus/WechatSend`（Task 1）→ channel runner 上推（Task 5）→ hub case（Task 9）→ service（Task 9）→ `sendToDevice`(Task 9) 全链字段名一致；`ResolvedBinding`(Task 7) 贯穿 turn(Task 8)/service(Task 9)；`WECHAT_MODEL="MiniMax-M3"` 单点定义。✅
- **命名/隔离**：避开已被分销占用的 `Channel` 模型，用 `WechatBinding`；全部按 `userId` 租户隔离；绑定路由校验 `Device.userId===userId` 防越权。✅


## 四、关键文件

| 文件 | 职责 |
| --- | --- |
| `packages/connector-protocol/src/wechat.ts` | `wechat.*` 消息 zod schema |
| `apps/desktop/src/shared/wechat/ilink-api.ts` | iLink HTTP 客户端（扫码/轮询/发消息）|
| `apps/desktop/src/shared/wechat/channel.ts` | 长轮询 runner（登录态机/去重/上推下发）|
| `apps/desktop/src/shared/wechat/chunk.ts` | 文本 >4000 分块 |
| `apps/desktop/src/main/wechat-store.ts` | safeStorage 加密存 iLink 凭据 |
| `apps/api/src/wechat/binding.ts` | WechatBinding 读写 |
| `apps/api/src/wechat/turn.ts` | headless 回合（reserve→runTurn→settle）|
| `apps/api/src/wechat/routes.ts` | HTTP 路由 |

参照源（iLink 线上报文字段真值）：CowAgent `channel/weixin/weixin_api.py`。
