export async function withTimeout<T>(task: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([Promise.resolve(task), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
