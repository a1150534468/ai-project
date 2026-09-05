/**
 * `/api/models` 的加载态，设置页与模型广场共用。
 *
 * 两页原来各写一遍同样的 `let cancelled` + then/catch，而且都把「还没拉回来」和「服务端确实
 * 没给」压在 `models.length` 一个判断里 —— 拉挂了就永远转圈。收成一个状态机放在这里：
 * **ready 里的空数组是「确实没有模型」**，跟 loading 是两回事。
 *
 * `listModels` 自己会把服务端报错咽掉、回一个空列表（见 `api.ts`），所以 failed 这一档只有
 * 断网那类非 `ApiError` 才到得了。怎么说这句话留给各自的页面 —— 一边是「模型列表」，
 * 一边是「模型广场」。
 */
import { useEffect, useState } from "react";
import { errorMessage } from "../apiError";
import { listModels, type ModelOption } from "../api";

export type ModelCatalog =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly models: ModelOption[] }
  | { readonly status: "failed"; readonly reason: string };

export function useModelCatalog(): ModelCatalog {
  const [catalog, setCatalog] = useState<ModelCatalog>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    listModels()
      .then((models) => {
        if (!cancelled) setCatalog({ status: "ready", models });
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setCatalog({ status: "failed", reason: errorMessage(failure, "未知错误") });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return catalog;
}
