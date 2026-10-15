/**
 * Minimal shared-secret guard for admin-only endpoints.
 *
 * The project has no auth layer yet — the previous attempt (removed in the same
 * commit that added this) was CommonJS in an ESM package and imported modules
 * that never existed. Loan applications contain farmers' income and credit data,
 * so until real auth lands these routes are gated on an ADMIN_API_KEY sent as
 * the `x-admin-key` header.
 *
 * Fails CLOSED: if ADMIN_API_KEY is unset the route refuses every request rather
 * than silently becoming public.
 */
export function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    console.error("ADMIN_API_KEY is not set — refusing admin request");
    return res.status(503).json({ error: "Admin access is not configured on this server." });
  }

  const provided = req.get("x-admin-key");
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}
