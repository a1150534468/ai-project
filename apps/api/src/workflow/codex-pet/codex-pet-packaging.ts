/**
 * Codex 桌宠最终打包的门面。原文件 863 行,按依赖方向拆成 4 个同域文件,这里只做重新导出。
 * 对外导出的 7 个名字与拆分前逐字一致,`codex-pet-packaging.test.ts` / `codex-pet-runner.ts` /
 * `codex-pet-recovery-finalizer.ts` / `codex-pet-runner/runner-finalize.ts` /
 * `codex-pet-runner/runner-packaging-resume.ts` 零改动。
 *
 * 分工:
 *  - codex-pet-packaging-shared.ts     常量、产物键、内部形状、四个对外契约、canonical JSON/checksum
 *  - codex-pet-packaging-job.ts        Job 状态机:建单/恢复、抢 lease、进 packaging、延后或终结
 *  - codex-pet-packaging-artifacts.ts  产物 checkpoint:可用性判据、写 checkpoint、孤儿产物回收
 *  - codex-pet-packaging-run.ts        persistOrResumeCodexPetFinalPackage 主流程
 *
 * 依赖方向是单向的:shared → job;shared → artifacts;shared/job/artifacts → run。
 * 新增功能请挑一层落地,不要在本文件里写实现 —— 这里一旦有实现,拆分就白做了。
 */

export type {
  CodexPetDurablePackagingInput,
  CodexPetDurablePackagingResult,
  CodexPetFinalPackageSeed,
} from "./codex-pet-packaging-shared.js";
export {
  codexPetCanonicalValidationReport,
  codexPetFinalPackageInputRevision,
  CodexPetPackagingDeferredError,
} from "./codex-pet-packaging-shared.js";
export { persistOrResumeCodexPetFinalPackage } from "./codex-pet-packaging-run.js";
