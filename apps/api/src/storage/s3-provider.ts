import { loadS3Config, makeS3 } from "./s3-config.js";
import type { S3 } from "./s3-types.js";

/**
 * 进程级 S3 客户端 provider：惰性初始化 + 缓存 + **记住失败**。
 *
 * 为什么记失败：照 `agents/service.ts` 的既有语义 —— `loadS3Config()` 读的是
 * 进程启动就固定的环境变量，这一次抛错意味着永远会抛错。不记的话，没配 S3 的
 * 环境每来一个请求就白抛一次异常。`packages/db` 的 `lazySingleton` 只缓存成功
 * （create 抛错即下次重试），表达不了这个语义，所以这里用结果缓存。
 *
 * 未配置时的行为是**显式抛错**（把当时那次的 Error 原样重抛），不静默返回
 * null —— 静默降级会把配置缺失伪装成业务空结果。需要「没配就降级」的调用方
 * 自己 catch（如头像的 avatarPublicUrl、image 的 tryLoadS3）。
 *
 * 按 env 对象分缓存：绝大多数调用走默认的 process.env；测试与 sticker runner
 * 会注入自己的 env 对象，各自一份缓存，互不污染。
 */
type S3Result = { readonly ok: true; readonly s3: S3 } | { readonly ok: false; readonly error: Error };

const cacheByEnv = new WeakMap<NodeJS.ProcessEnv, S3Result>();

export function getS3(env: NodeJS.ProcessEnv = process.env): S3 {
  let result = cacheByEnv.get(env);
  if (!result) {
    try {
      result = { ok: true, s3: makeS3(loadS3Config(env)) };
    } catch (cause) {
      result = { ok: false, error: cause instanceof Error ? cause : new Error("S3 配置加载失败") };
    }
    cacheByEnv.set(env, result);
  }
  if (!result.ok) throw result.error;
  return result.s3;
}
