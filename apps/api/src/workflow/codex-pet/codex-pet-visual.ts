/**
 * codex-pet 视觉层的门面。原本这一个文件是 1156 行(路由 + 出图 + Seedream 适配 +
 * QA + 方向判定),P2.4 拆分后按依赖方向分成六个文件,这里只留转出:
 *
 * - `codex-pet-visual-types.ts`      判据形状与两个纯判定函数(叶子)
 * - `codex-pet-visual-client.ts`     选模型、校路由、建客户端、带重试发消息、校出处
 * - `codex-pet-visual-seedream.ts`   豆包提示词改写、chroma matte、构造参考图
 * - `codex-pet-visual-image.ts`      参考图压缩、图像模型合同、冷却与重试、出图入口
 * - `codex-pet-visual-qa.ts`         单票 / 合议判图、look 机制、身份说明书
 * - `codex-pet-visual-direction.ts`  三评审盲测方向、标注 16 向语义复核
 *
 * 导出面与拆分前逐字一致,仍是 27 个名字 —— 19 处外部 import(runner 六个分片、
 * recovery-finalizer、run-routes、codex-pet/index.ts 与 6 个测试文件)一行都不用改。
 *
 * 新代码要用更细的层就直接 import 对应文件,不要往这里补转出:门面放大契约等于把
 * 私有管道(`codexPetVisualClient`、`createCodexPetVisualMessage`)变成公共 API。
 */

export type {
  BlindDirectionClass,
  BlindDirectionPairVerdict,
  BlindDirectionValidation,
  CodexPetVisualModelProvenance,
  DirectionSemanticVerdict,
  GeneratedPetVisual,
  PetVisualQaConsensus,
  PetVisualQaVerdict,
} from "./codex-pet-visual-types.js";
export {
  codexPetVisualQaConsensusPasses,
  codexPetVisualQaVerdictPasses,
} from "./codex-pet-visual-types.js";
export {
  DEFAULT_CODEX_PET_VISUAL_QA_MODEL,
  assertCodexPetVisualQaRoute,
  resolveCodexPetVisualQaModel,
} from "./codex-pet-visual-client.js";
export {
  adaptCodexPetPromptForModel,
  createSeedreamPoseBoardScaffold,
  normalizeSeedreamChromaMatte,
  selectSeedreamGaitScaffoldVariants,
} from "./codex-pet-visual-seedream.js";
export {
  codexPetImageDispatchCooldownMs,
  codexPetImageMaxAttempts,
  codexPetImageRetryDelayMs,
  generateCodexPetVisual,
} from "./codex-pet-visual-image.js";
export {
  generateCodexPetIdentityGuide,
  generateCodexPetLookMechanics,
  runCodexPetVisualQa,
  runCodexPetVisualQaConsensus,
} from "./codex-pet-visual-qa.js";
export {
  runBlindDirectionQa,
  runLabeledDirectionSemantics,
} from "./codex-pet-visual-direction.js";
