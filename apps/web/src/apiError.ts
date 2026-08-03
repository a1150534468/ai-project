export class ApiError extends Error {
  readonly status: number;

  /**
   * The `data` object a structured error response carried, when it had one.
   *
   * Some endpoints answer a refusal with the state that caused it — the codex-pet
   * 409 returns the remaining paid-repair budget — and a caller that keeps only
   * `message` + `status` throws that away, leaving the UI unable to say how far
   * over the cap the user is.
   */
  readonly data: Record<string, unknown> | null;

  constructor(message: string, status: number, data: Record<string, unknown> | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error || fallback;
}

/** Read both the message and any structured `data` from one error response body. */
export async function readErrorBody(response: Response, fallback: string): Promise<{
  readonly message: string;
  readonly data: Record<string, unknown> | null;
}> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; data?: unknown };
  return {
    message: body.error || fallback,
    data: body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : null,
  };
}
