/**
 * The one place that maps a logical object key to a physical one.
 *
 * Business code, the `objectKey` database columns and every namespace validator
 * keep speaking *relative* keys (`workflow/images/<user>/...`, `kb/<id>/...`).
 * The environment folder (`dev` / `prod`) is applied here, on the way to the
 * bucket, so the same database row and the same validator work in every
 * environment and switching environments never rewrites stored keys.
 *
 * Never inline `${prefix}${key}` anywhere else: a missing or doubled prefix
 * silently writes to the wrong folder instead of failing.
 */

/**
 * Accept a single environment folder. Deliberately narrow: one segment, no
 * slashes, no dots, no whitespace. A prefix is part of every physical request,
 * so anything that could escape its folder (`..`, `/`, `\`) or change how the
 * URL parses is rejected at load time rather than silently trusted.
 */
export function normalizeKeyPrefix(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(trimmed)) {
    throw new Error("S3_KEY_PREFIX must be a single folder name (letters, digits, dot, dash, underscore)");
  }
  // `..` and friends pass the character class but still move the folder.
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    throw new Error("S3_KEY_PREFIX must not contain '..'");
  }
  return trimmed;
}

/**
 * Resolve a relative object key to its physical key inside the bucket.
 *
 * A key that already starts with the prefix is rejected rather than double
 * prefixed: that means a caller passed a physical key where a logical one was
 * expected, and quietly producing `dev/dev/...` would hide the bug.
 */
export function resolveKey(s3: { readonly keyPrefix: string }, key: string): string {
  const prefix = s3.keyPrefix;
  if (!prefix) return key;
  if (key === prefix || key.startsWith(`${prefix}/`)) {
    throw new Error(`Object key is already prefixed with '${prefix}'`);
  }
  return `${prefix}/${key}`;
}
