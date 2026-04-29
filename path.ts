/**
 * path.ts — Pure string-based path utilities (posix-style).
 *
 * These replace Node's `path` module so the dep-graph core can run in
 * non-Node environments (browser, Deno, Cloudflare Workers, etc.).
 *
 * All paths use '/' as the separator internally. The CLI adapter is
 * responsible for normalizing platform paths before handing them in.
 */

/** Canonical separator — always forward slash. */
export const sep = '/';

/** Normalize a path: collapse redundant separators, resolve . and .. */
export function normalize(p: string): string {
  if (p.length === 0) return '.';

  const isAbsolute = p.charCodeAt(0) === 47; // '/'
  // Replace backslashes, collapse repeated slashes
  const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else if (!isAbsolute) {
        resolved.push('..');
      }
    } else {
      resolved.push(seg);
    }
  }

  let result = resolved.join('/');
  if (isAbsolute) result = '/' + result;
  return result || (isAbsolute ? '/' : '.');
}

/** Join path segments together and normalize. */
export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'));
}

/**
 * Resolve a sequence of paths to an absolute path.
 * Works left-to-right; if a segment is absolute it resets the base.
 * Unlike Node's path.resolve, there is no concept of cwd here —
 * at least one segment should be absolute for a meaningful result.
 */
export function resolve(...parts: string[]): string {
  let resolved = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part) continue;
    resolved = resolved ? part + '/' + resolved : part;
    // If this segment is absolute, stop looking further left
    if (part.charCodeAt(0) === 47) break; // '/'
  }
  return normalize(resolved);
}

/** Return the directory portion of a path. */
export function dirname(p: string): string {
  const norm = normalize(p);
  const lastSlash = norm.lastIndexOf('/');
  if (lastSlash === -1) return '.';
  if (lastSlash === 0) return '/';
  return norm.slice(0, lastSlash);
}

/** Return the last segment of a path, optionally stripping a suffix. */
export function basename(p: string, ext?: string): string {
  const norm = normalize(p);
  const lastSlash = norm.lastIndexOf('/');
  const base = lastSlash === -1 ? norm : norm.slice(lastSlash + 1);
  if (ext && base.endsWith(ext)) {
    return base.slice(0, -ext.length);
  }
  return base;
}

/** Return the file extension including the dot, or '' if none. */
export function extname(p: string): string {
  const base = basename(p);
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return base.slice(dotIndex);
}

/**
 * Compute a relative path from `from` to `to`.
 * Both should be absolute (or at least share a common prefix structure).
 */
export function relative(from: string, to: string): string {
  const fromNorm = normalize(from);
  const toNorm = normalize(to);

  if (fromNorm === toNorm) return '';

  const fromParts = fromNorm.split('/').filter(Boolean);
  const toParts = toNorm.split('/').filter(Boolean);

  // Find common prefix length
  let common = 0;
  const maxLen = Math.min(fromParts.length, toParts.length);
  while (common < maxLen && fromParts[common] === toParts[common]) {
    common++;
  }

  // Number of ".." needed to go up from `from` to the common ancestor
  const ups = fromParts.length - common;
  const remainder = toParts.slice(common);

  const segments: string[] = [];
  for (let i = 0; i < ups; i++) segments.push('..');
  segments.push(...remainder);

  return segments.join('/') || '.';
}

/**
 * Check whether a path is absolute (starts with /).
 */
export function isAbsolute(p: string): boolean {
  return p.length > 0 && p.charCodeAt(0) === 47; // '/'
}
