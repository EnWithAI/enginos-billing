/**
 * Mirrors enginos-platform's `realmToRoutingSlug`.
 *
 * Duplicated rather than imported — the two services share a database but not a
 * codebase, and the platform has a conformance spec pinning this exact
 * transform. It is lossy (`org-acme.com` and `org.acme-com` both collapse to
 * `org_acme_com`), which is why the platform carries a unique constraint on the
 * result.
 */
export function realmToRoutingSlug(realm: string): string {
  return realm.replace(/[^a-zA-Z0-9_]/g, "_");
}
