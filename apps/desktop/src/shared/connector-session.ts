export interface ReuseRegisteredDeviceInput {
  readonly registeredDeviceId: string | null;
  readonly activeDeviceUserId: string | null;
  readonly sessionToken: string;
}

export function sessionUserIdFromToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId] = parts;
  return userId.trim().length > 0 ? userId : null;
}

export function shouldReuseRegisteredDevice(input: ReuseRegisteredDeviceInput): boolean {
  if (!input.registeredDeviceId || !input.activeDeviceUserId) return false;
  return sessionUserIdFromToken(input.sessionToken) === input.activeDeviceUserId;
}
