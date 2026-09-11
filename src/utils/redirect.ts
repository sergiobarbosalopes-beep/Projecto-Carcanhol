/**
 * Restricts a post-login redirect target to allowed internal protected
 * paths, to prevent open-redirect attacks via a manipulated
 * `redirectedFrom` query parameter.
 *
 * Only `/dashboard` and its subpaths are allowed in Phase 1 (the only
 * protected area). Anything else — absolute URLs, protocol-relative
 * (`//host`), backslash tricks, `javascript:` URIs, or paths outside the
 * allow-list — falls back to `/dashboard`.
 */
const ALLOWED_REDIRECT_PREFIX = "/dashboard";
const FALLBACK_REDIRECT = "/dashboard";

export function sanitizeRedirectPath(rawValue: string | null): string {
  if (!rawValue) {
    return FALLBACK_REDIRECT;
  }

  // Must be a single relative path starting with exactly one "/" — this
  // rejects absolute URLs (https://...), protocol-relative URLs (//host),
  // and backslash variants ( /\evil.com ) that browsers can interpret as
  // a different host.
  if (!/^\/(?!\/|\\)[^\s]*$/.test(rawValue)) {
    return FALLBACK_REDIRECT;
  }

  // Defense in depth against scheme smuggling (e.g. "/ javascript:...").
  if (/javascript:/i.test(rawValue)) {
    return FALLBACK_REDIRECT;
  }

  const isAllowed =
    rawValue === ALLOWED_REDIRECT_PREFIX ||
    rawValue.startsWith(`${ALLOWED_REDIRECT_PREFIX}/`) ||
    rawValue.startsWith(`${ALLOWED_REDIRECT_PREFIX}?`);

  return isAllowed ? rawValue : FALLBACK_REDIRECT;
}
