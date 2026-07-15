export function novelProjectIdFromHash(hash: string): string | null {
  const match = /^#novel\/([^/]+)\/workbench$/.exec(hash.trim());
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
