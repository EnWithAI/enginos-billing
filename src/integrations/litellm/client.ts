/**
 * The LiteLLM admin API, narrowed to the two team calls billing makes.
 *
 * Transport only: it reads and writes a team and says nothing about budgets.
 * What a team's cap SHOULD be is gateway-budget.service.ts.
 */

export interface GatewayTeam {
  spend: number;
  maxBudget: number | null;
  budgetDuration: string | null;
  /** A blocked team's keys are refused outright, whatever the budget says. */
  blocked: boolean;
  metadata: Record<string, unknown>;
}

export interface GatewayClient {
  team(teamId: string): Promise<GatewayTeam | null>;
  updateTeam(body: Record<string, unknown>): Promise<void>;
}

export function createGatewayClient({
  baseUrl,
  masterKey,
  timeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
}: {
  baseUrl: string;
  masterKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): GatewayClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${masterKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, any>;
    return { status: response.status, ok: response.ok, payload };
  }

  return {
    async team(teamId) {
      const { status, ok, payload } = await call("GET", `/team/info?team_id=${encodeURIComponent(teamId)}`);
      if (status === 404) return null;
      if (!ok) throw new Error(`LiteLLM /team/info failed (${status})`);
      const info = payload.team_info ?? {};
      return {
        spend: Number(info.spend ?? 0),
        maxBudget: info.max_budget ?? null,
        budgetDuration: info.budget_duration ?? null,
        blocked: info.blocked === true,
        metadata: info.metadata ?? {},
      };
    },

    async updateTeam(body) {
      const { status, ok } = await call("POST", "/team/update", body);
      if (!ok) throw new Error(`LiteLLM /team/update failed (${status})`);
    },
  };
}
