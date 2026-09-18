/**
 * End-to-end: a brand-new organisation, from registration to prepaid LLM usage.
 *
 * Drives the REAL local stack — nothing mocked except where a fault is injected
 * on purpose:
 *
 *   enginos-platform :4100   registration (email token read from smtp4dev :5080)
 *   enginos-billing  :4300   internal API + Chargebee webhook
 *   LiteLLM          :4000   team budget, billing_guard hook, real LLM calls
 *   Chargebee test site      customer, subscription, top-up invoice, captures
 *   ClickHouse / Postgres    spans and billing state
 *   enginos-billing worker   per-minute sweep (must be running)
 *
 * It CREATES a real dummy org (Keycloak realm, tenant DB, LiteLLM team) and a
 * Chargebee test-site customer + subscription, and STOPS the LiteLLM container
 * for about a minute. Local stack and Chargebee TEST site only.
 *
 *   npx tsx scripts/e2e-prepaid.ts
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnv(path: string) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
loadEnv(resolve(__dirname, "../.env"));

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set in enginos-billing/.env`);
  return v;
};

const PLATFORM = "http://localhost:4100/api/v1";
const BILLING = "http://localhost:4300";
const LITELLM = env("LITELLM_BASE_URL").replace(/\/+$/, "");
const SMTP4DEV = "http://localhost:5080";
const CB = `https://${env("CHARGEBEE_SITE")}.chargebee.com/api/v2`;
const RATE = Number(process.env.USD_PER_CREDIT ?? "0.001");
const TOPUP_CREDITS = Number(process.env.TOPUP_CREDITS ?? "1000");
const ITEM_PRICE = process.env.DEFAULT_ITEM_PRICE_ID ?? "pre-paid-test-v1-INR-Monthly";
const TOPUP_ITEM = process.env.TOPUP_ITEM_PRICE_ID ?? "token-pack-5m-INR";
const LITELLM_CONTAINER = "enginos-litellm";

// ── reporting ───────────────────────────────────────────────────────────────
type Result = { id: string; name: string; ok: boolean; detail: string };
const results: Result[] = [];
const t0 = Date.now();
const stamp = () => `+${Math.round((Date.now() - t0) / 1000)}s`.padStart(6);
const log = (msg: string) => console.log(`${stamp()}  ${msg}`);

function check(id: string, name: string, ok: boolean, detail = "") {
  results.push({ id, name, ok, detail });
  console.log(`${stamp()}  ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 5000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await sleep(everyMs);
  }
  log(`timed out waiting for: ${label}`);
  return null;
}

// ── http ────────────────────────────────────────────────────────────────────
async function http(method: string, url: string, opts: { headers?: Record<string, string>; json?: unknown; form?: Record<string, string | number> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(Object.entries(opts.form).map(([k, v]) => [k, String(v)])).toString();
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const cbAuth = { Authorization: `Basic ${Buffer.from(`${env("CHARGEBEE_API_KEY")}:`).toString("base64")}` };
const cb = (method: string, path: string, form?: Record<string, string | number>) =>
  http(method, `${CB}${path}`, { headers: cbAuth, ...(method === "GET" ? {} : { form: form ?? {} }) });
const cbGet = (path: string, query: Record<string, string | number> = {}) =>
  http("GET", `${CB}${path}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`, { headers: cbAuth });

const internal = { Authorization: `Bearer ${env("BILLING_INTERNAL_API_KEY")}` };
const hookAuth = (user: string, pass: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` });
const master = { Authorization: `Bearer ${env("LITELLM_MASTER_KEY")}` };

async function team(slug: string) {
  const r = await http("GET", `${LITELLM}/team/info?team_id=${encodeURIComponent(slug)}`, { headers: master });
  const t = r.data?.team_info;
  return t ? { maxBudget: t.max_budget as number | null, spend: Number(t.spend ?? 0), duration: t.budget_duration as string | null, blocked: t.blocked === true, metadata: (t.metadata ?? {}) as Record<string, unknown> } : null;
}

/**
 * An LLM call exactly as crewpe-agent-core makes one: master key + tenant tag.
 * Each prompt is unique unless one is passed, so LiteLLM's response cache —
 * which serves a repeat for $0 — does not answer it.
 */
async function llm(slug?: string, prompt = `Reply with: ok (${Math.random().toString(36).slice(2)})`) {
  const r = await http("POST", `${LITELLM}/v1/chat/completions`, {
    headers: master,
    json: { model: "conversation_economy", max_tokens: 5, messages: [{ role: "user", content: prompt }], ...(slug ? { metadata: { "crewpe.tenant_id": slug } } : {}) },
  });
  return { status: r.status, message: String(r.data?.error?.message ?? "") };
}

async function clickhouse(sql: string) {
  const auth = Buffer.from(`${process.env.CLICKHOUSE_USER ?? "default"}:${env("CLICKHOUSE_PASSWORD")}`).toString("base64");
  const r = await fetch(`${process.env.CLICKHOUSE_URL ?? "http://localhost:8123"}/?default_format=JSONEachRow`, { method: "POST", headers: { Authorization: `Basic ${auth}` }, body: sql });
  const text = await r.text();
  if (!r.ok) throw new Error(text.slice(0, 200));
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function litellmUp() {
  return waitFor("LiteLLM healthy", async () => (await fetch(`${LITELLM}/health/liveliness`).then((r) => r.ok).catch(() => false)), 180_000, 3000);
}

// ── the run ─────────────────────────────────────────────────────────────────
async function main() {
  const { prisma } = await import("../src/lib/db");
  const { createAccounts } = await import("../src/lib/account");
  const { createChargebee } = await import("../src/lib/chargebee");
  const { gatewayBudgetHooks } = await import("../src/lib/gateway");
  const { balanceOf } = await import("../src/lib/ledger");

  const account = (tenantId: string) => prisma.billingAccount.findUnique({ where: { tenantId } });
  const grants = (tenantId: string) => prisma.creditLedgerEntry.findMany({ where: { tenantId, entryType: "grant" } });
  const billingView = async (tenantId: string) => (await http("GET", `${BILLING}/api/internal/billing/${tenantId}`, { headers: internal })).data;

  // ── 0. preconditions ──
  log("── 0. preconditions");
  for (const [name, url] of [["platform", "http://localhost:4100/health"], ["billing", `${BILLING}/api/health`], ["litellm", `${LITELLM}/health/liveliness`], ["smtp4dev", `${SMTP4DEV}/api/messages`]] as const) {
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    check("P0", `${name} reachable`, ok, url);
    if (!ok) throw new Error(`${name} is down — start it first`);
  }

  // ── 1. registration ──
  log("── 1. register a brand-new organisation");
  const run = Date.now().toString(36);
  const domain = `e2e-billing-${run}.com`;
  const email = `owner@${domain}`;
  const start = await http("POST", `${PLATFORM}/auth/register/start`, { json: { email, fullName: "E2E Owner" } });
  check("R1", "registration started", start.status === 202, `HTTP ${start.status}`);

  const token = await waitFor("verification email", async () => {
    const list = (await http("GET", `${SMTP4DEV}/api/messages`)).data;
    const rows: any[] = Array.isArray(list) ? list : (list?.results ?? []);
    const msg = rows.find((m) => JSON.stringify(m.to ?? m.deliveredTo ?? "").includes(email));
    if (!msg) return null;
    const html = (await http("GET", `${SMTP4DEV}/api/messages/${msg.id}/html`)).data;
    const m = String(html).match(/token=([A-Za-z0-9%_.~-]+)/);
    return m ? decodeURIComponent(m[1]!) : null;
  }, 60_000, 2000);
  check("R2", "verification token received by email", !!token);
  if (!token) throw new Error("no verification email");

  const reg = await http("POST", `${PLATFORM}/auth/register`, { json: { verificationToken: token, email, password: "E2e-Billing-Test-9!x", fullName: "E2E Owner" } });
  check("R3", "registration completed", reg.status === 201, `HTTP ${reg.status}`);

  const tenant = await waitFor("tenant row", async () => (await prisma.$queryRaw<Array<{ tenant_id: string; realm_name: string }>>`
    SELECT tenant_id::text, realm_name FROM tenants WHERE domain = ${domain} AND deleted_at IS NULL LIMIT 1`)[0], 60_000, 2000);
  if (!tenant) throw new Error("tenant not created");
  const tenantId = tenant.tenant_id;

  const gw = await waitFor("LiteLLM team provisioned", async () => (await prisma.$queryRaw<Array<{ routing_slug: string; litellm_team_id: string | null; plan: string }>>`
    SELECT routing_slug, litellm_team_id, plan::text FROM org_llm_gateways WHERE tenant_id = ${tenantId}::uuid`)[0], 90_000, 3000);
  check("R4", "LiteLLM gateway provisioned for the new org", !!gw?.litellm_team_id, gw ? `team=${gw.litellm_team_id} plan=${gw.plan}` : "no org_llm_gateways row");
  if (!gw?.litellm_team_id) throw new Error("gateway not provisioned");
  const slug = gw.routing_slug;
  log(`tenant ${tenantId}  slug ${slug}  realm ${tenant.realm_name}`);

  // ── 2. before subscribing: no budget ──
  log("── 2. before subscribing");
  let t = await team(slug);
  check("B1", "new team starts at $0 and is not billing-managed", t?.maxBudget === 0 && t.metadata.billing_managed !== true, JSON.stringify({ max: t?.maxBudget, managed: t?.metadata.billing_managed }));
  let call = await llm(slug);
  check("B2", "agent-core-style call refused: 402 subscription required", call.status === 402 && /no LLM budget/i.test(call.message), `HTTP ${call.status} ${call.message.slice(0, 80)}`);
  call = await llm();
  check("B3", "untagged traffic unaffected by the guard", call.status === 200, `HTTP ${call.status}`);

  const view0 = await billingView(tenantId);
  check("B4", "billing page: unlinked, 0 credits", view0?.status === "unlinked" && view0?.credits?.current === "0", JSON.stringify({ status: view0?.status, credits: view0?.credits?.current }));

  const earlyTopup = await http("POST", `${BILLING}/api/internal/topup`, { headers: internal, json: { tenantId, apply: true } });
  check("B5", "top-up before subscribing refused (409 no-subscription)", earlyTopup.status === 409 && earlyTopup.data?.code === "no-subscription", `HTTP ${earlyTopup.status} ${earlyTopup.data?.code}`);

  // ── 3. checkout + subscription ──
  log("── 3. checkout and subscribe (Chargebee test site)");
  const co1 = await http("POST", `${BILLING}/api/internal/checkout`, { headers: internal, json: { tenantId, itemPriceId: ITEM_PRICE } });
  const co2 = await http("POST", `${BILLING}/api/internal/checkout`, { headers: internal, json: { tenantId, itemPriceId: ITEM_PRICE } });
  const cust = await cbGet(`/customers/${tenantId}`);
  check("S1", "checkout creates ONE Chargebee customer whose id is the tenant id (idempotent)", co1.status === 200 && co2.status === 200 && cust.status === 200, `checkout ${co1.status}/${co2.status}, customer ${cust.status}`);

  const sub = await cb("POST", `/customers/${tenantId}/subscription_for_items`, {
    "subscription_items[item_price_id][0]": ITEM_PRICE,
    "subscription_items[quantity][0]": 1,
    auto_collection: "off",
  });
  const subscriptionId: string = sub.data?.subscription?.id;
  check("S2", "subscription created in Chargebee", sub.status === 200 && !!subscriptionId, `HTTP ${sub.status} ${sub.data?.message ?? subscriptionId}`);
  if (!subscriptionId) throw new Error("subscription not created");

  const grantBlocks = async () => ((await cbGet("/grant_blocks", { "subscription_id[is]": subscriptionId, limit: 10 })).data?.list ?? []).length;
  if ((await waitFor("credit grant", async () => (await grantBlocks()) > 0, 20_000, 3000)) === null) {
    const inv = sub.data?.invoice ?? ((await cbGet("/invoices", { "subscription_id[is]": subscriptionId, limit: 1 })).data?.list?.[0]?.invoice);
    if (inv?.id && inv.amount_due > 0) {
      const paid = await cb("POST", `/invoices/${inv.id}/record_payment`, { "transaction[amount]": inv.amount_due, "transaction[payment_method]": "cash", "transaction[date]": Math.floor(Date.now() / 1000) });
      log(`recorded offline payment on ${inv.id}: HTTP ${paid.status}`);
    }
  }
  const blocks = await waitFor("credit grant after payment", async () => (await grantBlocks()) || null, 30_000, 3000);
  check("S3", "Chargebee granted credits for the subscription", !!blocks, `${blocks ?? 0} grant block(s)`);

  const subNow = (await cbGet(`/subscriptions/${subscriptionId}`)).data?.subscription;

  // ── 4. webhook ──
  log("── 4. Chargebee webhook → billing → LiteLLM");
  const eventId = `ev_e2e_${run}_created`;
  const event = { id: eventId, event_type: "subscription_created", content: { subscription: subNow } };
  const noAuth = await http("POST", `${BILLING}/api/webhooks/chargebee`, { json: event });
  const badAuth = await http("POST", `${BILLING}/api/webhooks/chargebee`, { headers: hookAuth(env("CHARGEBEE_WEBHOOK_USER"), "wrong"), json: event });
  check("W1", "webhook without / with wrong credentials refused", noAuth.status === 401 && badAuth.status === 401, `${noAuth.status}/${badAuth.status}`);

  const hook = await http("POST", `${BILLING}/api/webhooks/chargebee`, { headers: hookAuth(env("CHARGEBEE_WEBHOOK_USER"), env("CHARGEBEE_WEBHOOK_PASSWORD")), json: event });
  check("W2", "subscription_created webhook accepted", hook.status === 200 && hook.data?.handled !== false, JSON.stringify(hook.data));

  const acct1 = await account(tenantId);
  const g1 = await grants(tenantId);
  const bought = g1.reduce((s, e) => s + Number(e.deltaCredits), 0);
  check("W3", "account active with the granted credits in the ledger", acct1?.status === "active" && g1.length === 1 && bought > 0, `status=${acct1?.status} grants=${g1.length} credits=${bought}`);
  const baseline = Number((await team(slug))?.metadata.billing_spend_baseline ?? NaN);
  t = await team(slug);
  const expectedCap = (credits: number) => Math.round((baseline + credits * RATE) * 1e6) / 1e6;
  check("W4", `LiteLLM cap = baseline + credits × ${RATE}, no rolling reset, billing-managed`, t?.maxBudget === expectedCap(bought) && t.duration === null && t.metadata.billing_managed === true && !t.blocked, JSON.stringify({ max: t?.maxBudget, expected: expectedCap(bought), duration: t?.duration, baseline }));
  call = await llm(slug);
  check("W5", "LLM call now allowed", call.status === 200, `HTTP ${call.status} ${call.message.slice(0, 80)}`);

  const dup = await http("POST", `${BILLING}/api/webhooks/chargebee`, { headers: hookAuth(env("CHARGEBEE_WEBHOOK_USER"), env("CHARGEBEE_WEBHOOK_PASSWORD")), json: event });
  check("W6", "duplicate webhook delivery is a no-op", dup.data?.duplicate === true && (await grants(tenantId)).length === 1, JSON.stringify(dup.data));

  // The customer's browser calls this right after checkout, while Chargebee
  // also sends the webhook: both paths fire for the same term in production.
  const syncAfter = await http("POST", `${BILLING}/api/internal/sync-subscription`, { headers: internal, json: { tenantId } });
  const g2 = await grants(tenantId);
  const allocated2 = g2.reduce((s, e) => s + Number(e.deltaCredits), 0);
  t = await team(slug);
  check("W7", "webhook + post-checkout sync for the SAME term grant once (no double credits)", syncAfter.status === 200 && allocated2 === bought && t?.maxBudget === expectedCap(bought), `grants=${g2.length} [${g2.map((e) => `${e.sourceRef}:${Number(e.deltaCredits)}`).join(", ")}] cap=${t?.maxBudget}`);

  // ── 5. usage → ClickHouse → capture ──
  log("── 5. usage is metered and billed");
  const before5 = (await team(slug))?.spend ?? 0;
  for (let i = 0; i < 3; i++) check("U1", `LLM call ${i + 1}/3 allowed`, (await llm(slug)).status === 200);
  // One prompt sent twice: the repeat is answered from LiteLLM's cache for $0
  // and must not be billed either.
  const repeated = `Reply with: cached (${run})`;
  await llm(slug, repeated);
  await sleep(2000);
  await llm(slug, repeated);
  const realCalls = 5; // W5 + 3 × U1 + the first of the repeated pair
  const col = await clickhouse(`SELECT default_expression AS d FROM system.columns WHERE database = 'tenant_${slug}' AND table = 'span_nodes' AND name = 'ingested_at'`);
  check("K0", "new tenant DB provisioned with span_nodes.ingested_at (migration 029)", /now64/.test(String(col[0]?.d ?? "")), `default=${col[0]?.d ?? "missing"}`);
  const spans = await waitFor("spans in tenant ClickHouse DB", async () => {
    const rows = await clickhouse(`SELECT count() AS n FROM tenant_${slug}.span_nodes FINAL WHERE SpanName = 'litellm_request' AND attrs['gen_ai.cost.total_cost'] != ''`);
    return Number(rows[0]?.n ?? 0) >= realCalls + 1 ? Number(rows[0]!.n) : null;
  }, 240_000, 10_000);
  check("U2", "LiteLLM spans routed to the tenant's ClickHouse DB", !!spans, `${spans ?? 0} costed spans (incl. 1 cache hit)`);
  const captured = await waitFor("captured usage", async () => prisma.usageSyncBatch.findFirst({ where: { tenantId, status: "captured", spanCount: { gt: 0 } }, orderBy: { createdAt: "desc" } }), 300_000, 10_000);
  check("U3", "worker captured usage events against Chargebee", !!captured, captured ? `spans=${captured.spanCount} credits=${captured.consumeCredits}` : "none within 5 min");
  if (captured) {
    const op = await cbGet(`/ledger_operations/${captured.id}`);
    check("U4", "Chargebee holds the capture under the batch id", op.status === 200 && String(op.data?.ledger_operation?.type).includes("capture"), `HTTP ${op.status}`);
    const entry = await prisma.creditLedgerEntry.findFirst({ where: { tenantId, sourceRef: captured.id } });
    check("U5", "ledger consume entry recorded", entry?.entryType === "consume", `${entry?.deltaCredits}`);
  }
  const spendAfter = await waitFor("team spend attributed", async () => { const s = (await team(slug))?.spend ?? 0; return s > before5 ? s : null; }, 60_000, 5000);
  check("U6", "master-key spend counted against the team (guard attribution)", !!spendAfter, `spend ${before5} → ${spendAfter}`);
  t = await team(slug);
  check("U7", "platform reconciler left the prepaid cap alone (> 60 s later)", t?.maxBudget === expectedCap(allocated2), `max=${t?.maxBudget}`);

  // Chargebee and LiteLLM must run down at the same rate, or one runs out first.
  const settledUsage = await waitFor("every real call billed", async () => {
    const rows = await prisma.usageSyncBatch.findMany({ where: { tenantId, status: "captured" } });
    const spansBilled = rows.reduce((s: number, b: { spanCount: bigint }) => s + Number(b.spanCount), 0);
    return spansBilled >= realCalls ? rows : null;
  }, 300_000, 10_000);
  const billedUsd = (settledUsage ?? []).reduce((s: number, b: { billedUsd: unknown }) => s + Number(b.billedUsd), 0);
  const spansBilled = (settledUsage ?? []).reduce((s: number, b: { spanCount: bigint }) => s + Number(b.spanCount), 0);
  await sleep(15_000); // LiteLLM flushes team spend in batches
  const litellmSpend = (await team(slug))?.spend ?? 0;
  check("U8", "cache hit NOT billed: spans billed = real provider calls", spansBilled === realCalls, `${spansBilled} billed of ${realCalls} real + 1 cached`);
  check("U9", "Chargebee drawdown equals LiteLLM team spend", Math.abs(billedUsd - (litellmSpend - baseline)) < 1e-9, `billed $${billedUsd} vs LiteLLM $${litellmSpend - baseline}`);

  // The cursor: one idempotency key per billed span, and the cursor at or past
  // every capture it settled — else the next read would charge that usage again.
  const keys = await prisma.billedUsageEvent.findMany({ where: { tenantId, batchId: { in: (settledUsage ?? []).map((b: { id: string }) => b.id) } } });
  check("K1", "one event key per billed span (TraceId:SpanId), none twice", keys.length === spansBilled && new Set(keys.map((k: { eventKey: string }) => k.eventKey)).size === keys.length, `${keys.length} keys for ${spansBilled} spans`);
  const cur = await prisma.billingCursor.findUnique({ where: { tenantId } });
  const behind = (settledUsage ?? []).filter((b: { cursorToAt: Date | null; cursorToEventId: string | null }) =>
    b.cursorToAt && cur && (b.cursorToAt > cur.lastProcessedAt || (b.cursorToAt.getTime() === cur.lastProcessedAt.getTime() && (b.cursorToEventId ?? "") > cur.lastEventId)));
  check("K2", "cursor is at or past every settled capture", !!cur && behind.length === 0, `cursor ${cur?.lastProcessedAt.toISOString()} / '${cur?.lastEventId}', ${behind.length} capture(s) ahead of it`);
  const lagMs = Number(process.env.BILLING_LAG_MS ?? 120_000);
  const tracking = await waitFor("cursor tracks safe_until", async () => {
    const c = await prisma.billingCursor.findUnique({ where: { tenantId } });
    const gap = c ? Date.now() - c.lastProcessedAt.getTime() : Infinity;
    return gap >= lagMs - 5_000 && gap <= lagMs + 150_000 ? gap : null;
  }, 150_000, 5000);
  check("K3", "idle cursor follows now − lag (empty ticks advance it)", !!tracking, `now − cursor = ${tracking ? Math.round(tracking / 1000) : "?"} s, lag ${lagMs / 1000} s`);

  // ── 6. LiteLLM down while a top-up lands ──
  log("── 6. LiteLLM outage during a top-up budget update");
  const topInv = await cb("POST", "/invoices/create_for_charge_items_and_charges", { customer_id: tenantId, "item_prices[item_price_id][0]": TOPUP_ITEM, "item_prices[quantity][0]": 1, auto_collection: "off" });
  const inv = topInv.data?.invoice;
  if (inv?.id && inv.amount_due > 0) await cb("POST", `/invoices/${inv.id}/record_payment`, { "transaction[amount]": inv.amount_due, "transaction[payment_method]": "cash", "transaction[date]": Math.floor(Date.now() / 1000) });
  check("O1", "top-up invoice created and paid in Chargebee", topInv.status === 200 && !!inv?.id, `HTTP ${topInv.status} ${topInv.data?.message ?? inv?.id}`);

  execSync(`docker stop ${LITELLM_CONTAINER}`, { stdio: "ignore" });
  log("LiteLLM stopped");
  const topup = await http("POST", `${BILLING}/api/internal/topup`, { headers: internal, json: { tenantId, apply: true } });
  const acct2 = await account(tenantId);
  check("O2", "top-up applied, account held 'activating' (push failed)", topup.status === 200 && topup.data?.applied === 1 && acct2?.status === "activating", `HTTP ${topup.status} ${JSON.stringify(topup.data)} status=${acct2?.status}`);
  const view2 = await billingView(tenantId);
  check("O3", "billing page shows NO credits while activating", view2?.status === "activating" && view2?.credits?.current === "0" && (view2?.history ?? []).length === 0, JSON.stringify({ status: view2?.status, credits: view2?.credits?.current }));

  execSync(`docker start ${LITELLM_CONTAINER}`, { stdio: "ignore" });
  check("O4", "LiteLLM back up", !!(await litellmUp()));
  const active = await waitFor("worker re-activation", async () => (await account(tenantId))?.status === "active", 150_000, 5000);
  const allocated3 = Number((await balanceOf(tenantId, prisma)).allocated);
  t = await team(slug);
  check("O5", "per-minute retry activated it: cap raised by the top-up, unblocked", !!active && t?.maxBudget === expectedCap(allocated3) && !t.blocked, JSON.stringify({ status: (await account(tenantId))?.status, max: t?.maxBudget, expected: expectedCap(allocated3), allocated: allocated3 }));
  check("O6", "LLM call allowed again", (await llm(slug)).status === 200);

  // ── 7. push fails but the block lands (fault injected at the push only) ──
  log("── 7. budget push fails, block succeeds");
  const hooks = gatewayBudgetHooks();
  const faulty = createAccounts({
    chargebee: createChargebee(),
    usdPerCredit: String(RATE),
    logger: { log() {}, warn() {}, error() {} },
    pushBudget: async () => { throw new Error("injected: LiteLLM /team/update failed (503)"); },
    blockBudget: hooks.blockBudget,
  });
  await faulty.syncFromChargebee(tenantId);
  t = await team(slug);
  check("F1", "account activating and LiteLLM team blocked", (await account(tenantId))?.status === "activating" && t?.blocked === true, JSON.stringify({ status: (await account(tenantId))?.status, blocked: t?.blocked }));
  call = await llm(slug);
  check("F2", "every request refused while blocked (403)", call.status === 403, `HTTP ${call.status} ${call.message.slice(0, 80)}`);
  const reactivated = await waitFor("worker re-activation", async () => (await account(tenantId))?.status === "active", 150_000, 5000);
  t = await team(slug);
  check("F3", "retry set the cap and unblocked in one update", !!reactivated && !t?.blocked && t?.maxBudget === expectedCap(allocated3), JSON.stringify({ blocked: t?.blocked, max: t?.maxBudget }));
  check("F4", "requests allowed again", (await llm(slug)).status === 200);

  // ── 8. capture response lost: recovery must not charge twice ──
  log("── 8. capture landed but its response was lost");
  // A worker that dies between Chargebee's reply and the settle leaves its
  // lease on the cursor and its capture pending. Reproduce exactly that: take
  // the lease as a dead worker would, record the capture, send it, never settle.
  const leaseMs = 30_000;
  const leased = await waitFor("tenant lease free, nothing pending", async () => {
    if (await prisma.usageSyncBatch.findFirst({ where: { tenantId, status: "pending" } })) return null;
    const now = new Date();
    const r = await prisma.billingCursor.updateMany({
      where: { tenantId, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedUntil: new Date(now.getTime() + leaseMs), lockedBy: `e2e-dead-worker-${run}` },
    });
    return r.count === 1 ? now : null;
  }, 120_000, 2000);
  check("L0", "dead worker holds the tenant's cursor lease", !!leased);
  const at = (await prisma.billingCursor.findUnique({ where: { tenantId } }))!;
  const acct3 = (await account(tenantId))!;
  const cbClient = createChargebee();
  const usableBefore = Number((await cbClient.balance(acct3.chargebeeSubscriptionId!))?.usable ?? NaN);
  // cursorTo = where the cursor already is: the capture's usage is behind it.
  const lost = await prisma.usageSyncBatch.create({
    data: { tenantId, chargebeeSubscriptionId: acct3.chargebeeSubscriptionId, ledgerUnitId: acct3.ledgerUnitId, windowStart: at.lastProcessedAt, windowEnd: at.lastProcessedAt, cursorToAt: at.lastProcessedAt, cursorToEventId: at.lastEventId, spanCount: BigInt(1), billedUsd: "0.0005", providerUsd: "0.0005", marginUsd: "0", consumeCredits: "0.5", status: "pending" },
  });
  const landed = await cbClient.capture({ id: lost.id, subscriptionId: acct3.chargebeeSubscriptionId!, unitId: acct3.ledgerUnitId!, amount: "0.5" });
  check("L1", "capture landed in Chargebee (response 'lost' — batch left pending)", landed.kind === "captured", landed.kind);
  await sleep(10_000);
  check("L4", "worker leaves a leased tenant alone (lease not yet expired)", (await prisma.usageSyncBatch.findUnique({ where: { id: lost.id } }))?.status === "pending");
  const settled = await waitFor("recovery", async () => { const b = await prisma.usageSyncBatch.findUnique({ where: { id: lost.id } }); return b?.status === "captured" ? b : null; }, 150_000, 5000);
  const usableAfter = Number((await cbClient.balance(acct3.chargebeeSubscriptionId!))?.usable ?? NaN);
  check("L2", "lease expired; worker recovered the capture by looking it up, not re-sending", settled?.chargebeeOperationId === lost.id, `status=${settled?.status}`);
  check("L3", "Chargebee balance dropped by exactly 0.5 (charged once)", Math.abs(usableBefore - usableAfter - 0.5) < 1e-6, `usable ${usableBefore} → ${usableAfter}`);
  const lostEntries = await prisma.creditLedgerEntry.count({ where: { tenantId, sourceRef: lost.id } });
  check("L5", "exactly one ledger consume entry for the recovered capture", lostEntries === 1, `${lostEntries}`);

  // ── 9. Chargebee credits run out ──
  log("── 9. Chargebee credits run out before the LiteLLM cap");
  const acct4 = (await account(tenantId))!;
  const drainFrom = Number((await cbClient.balance(acct4.chargebeeSubscriptionId!))?.usable ?? 0);
  // Spend the whole balance outside billing — the drift the LiteLLM cap cannot see.
  const drained = await cbClient.capture({ id: `e2e-drain-${run}`, subscriptionId: acct4.chargebeeSubscriptionId!, unitId: acct4.ledgerUnitId!, amount: String(drainFrom) });
  const usableNow = Number((await cbClient.balance(acct4.chargebeeSubscriptionId!))?.usable ?? NaN);
  check("X1", "Chargebee balance drained to 0 (LiteLLM cap still open)", drained.kind === "captured" && usableNow === 0 && !(await team(slug))?.blocked, `usable ${drainFrom} → ${usableNow}`);
  check("X2", "a call still passes LiteLLM (its cap has room)", (await llm(slug)).status === 200);
  const exhausted = await waitFor("billing notices the empty balance", async () => (await account(tenantId))?.status === "exhausted", 300_000, 10_000);
  t = await team(slug);
  check("X3", "account exhausted and LiteLLM team blocked for exhaustion", !!exhausted && t?.blocked === true && t.metadata.billing_block_reason === "exhausted", JSON.stringify({ status: (await account(tenantId))?.status, blocked: t?.blocked, reason: t?.metadata.billing_block_reason }));
  call = await llm(slug);
  check("X4", "requests refused: 402 credits used up", call.status === 402 && /used all of its prepaid credits/i.test(call.message), `HTTP ${call.status} ${call.message.slice(0, 80)}`);
  const view3 = await billingView(tenantId);
  check("X5", "billing page shows exhausted", view3?.status === "exhausted", `status=${view3?.status}`);
  const held = await prisma.usageSyncBatch.findFirst({ where: { tenantId, status: "failed", lastError: { startsWith: "insufficient credits" } } });
  log(`held capture (Chargebee refused for balance): ${held ? held.id : "none — the unit allowed overdraft"}`);
  if (held) {
    const c = await prisma.billingCursor.findUnique({ where: { tenantId } });
    check("X9", "cursor did not move past the refused capture", !!c && !!held.cursorToAt && c.lastProcessedAt < held.cursorToAt, `cursor ${c?.lastProcessedAt.toISOString()} < capture end ${held.cursorToAt?.toISOString()}`);
  }

  const inv2 = (await cb("POST", "/invoices/create_for_charge_items_and_charges", { customer_id: tenantId, "item_prices[item_price_id][0]": TOPUP_ITEM, "item_prices[quantity][0]": 1, auto_collection: "off" })).data?.invoice;
  if (inv2?.id && inv2.amount_due > 0) await cb("POST", `/invoices/${inv2.id}/record_payment`, { "transaction[amount]": inv2.amount_due, "transaction[payment_method]": "cash", "transaction[date]": Math.floor(Date.now() / 1000) });
  const topup2 = await http("POST", `${BILLING}/api/internal/topup`, { headers: internal, json: { tenantId, apply: true } });
  t = await team(slug);
  check("X6", "top-up reopens it: active, unblocked, reason cleared", topup2.data?.applied === 1 && (await account(tenantId))?.status === "active" && !t?.blocked && t?.metadata.billing_block_reason === undefined, JSON.stringify({ topup: topup2.data, status: (await account(tenantId))?.status, blocked: t?.blocked }));
  check("X7", "requests allowed again after the top-up", (await llm(slug)).status === 200);
  if (held) {
    const recaptured = await waitFor("held capture settled", async () => { const b = await prisma.usageSyncBatch.findUnique({ where: { id: held.id } }); return b?.status === "captured" ? b : null; }, 180_000, 10_000);
    const op = await cbGet(`/ledger_operations/${held.id}`);
    check("X8", "the refused capture was requeued and charged once", !!recaptured && op.status === 200, `status=${recaptured?.status} op=${op.status}`);
    const c = await prisma.billingCursor.findUnique({ where: { tenantId } });
    check("X10", "cursor advanced past it only once it was charged", !!c && !!recaptured?.cursorToAt && c.lastProcessedAt >= recaptured.cursorToAt, `cursor ${c?.lastProcessedAt.toISOString()}`);
  }

  // ── 10. cancellation ──
  // Chargebee refuses an immediate cancel for a subscription with credit
  // grants; it cancels at term end and sends subscription_cancelled then.
  log("── 10. cancellation (at term end)");
  const cancel = await cb("POST", `/subscriptions/${subscriptionId}/cancel_for_items`, { end_of_term: "true" });
  check("C0", "Chargebee schedules the cancellation for term end", cancel.status === 200 && cancel.data?.subscription?.status === "non_renewing", `HTTP ${cancel.status} ${cancel.data?.subscription?.status ?? cancel.data?.message}`);
  const cancelled = { ...(cancel.data?.subscription ?? subNow), status: "cancelled" }; // as delivered at term end
  const cancelHook = await http("POST", `${BILLING}/api/webhooks/chargebee`, { headers: hookAuth(env("CHARGEBEE_WEBHOOK_USER"), env("CHARGEBEE_WEBHOOK_PASSWORD")), json: { id: `ev_e2e_${run}_cancelled`, event_type: "subscription_cancelled", content: { subscription: cancelled } } });
  t = await team(slug);
  check("C1", "term-end webhook: account cancelled, team handed back to the plan", cancelHook.status === 200 && (await account(tenantId))?.status === "cancelled" && t?.metadata.billing_managed === undefined, JSON.stringify({ hook: cancelHook.data, status: (await account(tenantId))?.status, managed: t?.metadata.billing_managed }));
  const reset = await waitFor("platform reconciler resets cap to $0", async () => (await team(slug))?.maxBudget === 0, 120_000, 5000);
  check("C2", "platform reconciler reset the cap to the free plan's $0", !!reset, `max=${(await team(slug))?.maxBudget}`);
  call = await llm(slug);
  check("C3", "requests refused again after cancellation (402)", call.status === 402, `HTTP ${call.status}`);

  await prisma.$disconnect();
  return { tenantId, slug, domain, subscriptionId };
}

main()
  .then((ids) => finish(ids))
  .catch((err) => {
    console.error(`${stamp()}  ABORTED: ${(err as Error).message}`);
    check("ABORT", "run completed without an unexpected error", false, (err as Error).message.split("\n").filter(Boolean).slice(-1)[0] ?? "");
    try { execSync(`docker start ${LITELLM_CONTAINER}`, { stdio: "ignore" }); } catch {}
    finish(null);
  });

function finish(ids: Record<string, string> | null) {
  const failed = results.filter((r) => !r.ok);
  console.log("\n══ summary ══");
  console.log(`${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const f of failed) console.log(`  FAIL ${f.id} ${f.name} — ${f.detail}`);
  if (ids) console.log(`dummy org: ${JSON.stringify(ids)}`);
  process.exit(failed.length ? 1 : 0);
}
