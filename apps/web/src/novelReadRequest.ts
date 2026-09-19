import { request, type RequestOptions } from "./http";

/** In-flight sharing only. Never cache settled data or share across identities. */
export function createNovelRequest(transport: typeof request = request): typeof request {
  const pending = new Map<string, Promise<unknown>>();
  return function novelRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (options.method && options.method !== "GET") {
      // Reads begun before or during a write cannot satisfy a post-write refresh.
      pending.clear();
      return transport<T>(path, options).finally(() => pending.clear());
    }
    if (options.signal) return transport<T>(path, options);
    const key = JSON.stringify([options.token, path, options.headers, options.credentials]);
    const existing = pending.get(key);
    if (existing) return existing as Promise<T>;
    const result = transport<T>(path, options).finally(() => {
      if (pending.get(key) === result) pending.delete(key);
    });
    pending.set(key, result);
    return result;
  };
}
