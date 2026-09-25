/**
 * Read-only access to tables enginos-platform owns.
 *
 * Raw SQL on purpose: `tenants` and `org_llm_gateways` belong to the platform.
 * Modelling them in our Prisma schema would let `prisma migrate` propose
 * changes to tables we have no business touching.
 */

import { prisma as defaultPrisma, type PrismaClient } from "../db/prisma";

export interface TenantFacts {
  tenantId: string;
  /** The gateway's slug, or null when the tenant has no gateway row. */
  gatewaySlug: string | null;
  realmName: string;
  orgName: string;
}

export function createPlatformRepository(prisma: PrismaClient = defaultPrisma) {
  return {
    async tenantFacts(tenantId: string): Promise<TenantFacts | null> {
      const rows = await prisma.$queryRaw<
        Array<{ tenant_id: string; realm_name: string; routing_slug: string | null; org_name: string }>
      >`
        SELECT t.tenant_id::text, t.realm_name, t.org_name, g.routing_slug
          FROM tenants t
          LEFT JOIN org_llm_gateways g ON g.tenant_id = t.tenant_id
         WHERE t.tenant_id = ${tenantId}::uuid
           AND t.deleted_at IS NULL
         LIMIT 1
      `;
      const tenant = rows[0];
      if (!tenant) return null;
      return {
        tenantId: tenant.tenant_id,
        gatewaySlug: tenant.routing_slug,
        realmName: tenant.realm_name,
        orgName: tenant.org_name,
      };
    },

    /** The tenant's LiteLLM team id, or null when the platform never provisioned one. */
    async litellmTeamId(tenantId: string): Promise<string | null> {
      const rows = await prisma.$queryRaw<Array<{ litellm_team_id: string | null }>>`
        SELECT litellm_team_id FROM org_llm_gateways WHERE tenant_id = ${tenantId}::uuid LIMIT 1
      `;
      return rows[0]?.litellm_team_id ?? null;
    },

    /** Readiness: can we reach the database at all. */
    async ping(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`;
    },
  };
}

export type PlatformRepository = ReturnType<typeof createPlatformRepository>;
