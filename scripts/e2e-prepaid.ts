/**
 * End-to-end: a brand-new organisation, from registration to prepaid LLM usage.
 *
 * Drives the REAL local stack — nothing mocked except where a fault is injected
 * on purpose:
 *
 *   enginos-platform :4100   registration (email token read from smtp4dev :5080)
 *   enginos-billing  :4300   internal API + Chargebee webhook, called directly
 *                            and with no credentials, standing in for
 *                            enginos-platform (billing authenticates no caller)
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
import { randomUUID } from "node:crypto";
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
  const { prisma } = await import("../src/db/prisma");
  const { createAccountService } = await import("../src/services/account.service");
  const { createChargebee } = await import("../src/integrations/chargebee");
  const { gatewayBudgetHooks } = await import("../src/container/budget-hooks");

  const cbClient = createChargebee();
  const account = (tenantId: string) => prisma.billingAccount.findUnique({ where: { tenantId } });
  /** THE cursor: where the billing worker has got to, in epoch ms. */
  const cursorAt = async (tenantId: string) =>
    (await prisma.billingAccount.findUnique({ where: { tenantId } }))?.lastProcessedIngestedAt?.getTime() ?? null;
  /** The newest resolved sync — what was billed, as opposed to how far we got. */
  const lastSync = (tenantId: string) =>
    prisma.chargebeeSync.findFirst({ where: { tenantId, status: "SUCCESS" }, orderBy: { toIngestedAt: "desc" } });
  /** Whatever is holding the tenant, if anything. This is the sync status. */
  const stuckRow = (tenantId: string) =>
    prisma.chargebeeSync.findFirst({
      where: { tenantId, status: { not: "SUCCESS" } },
      orderBy: { fromIngestedAt: "asc" },
    });
  // Credits are CHARGEBEE'S. There is no local ledger to read any more, so
  // every credit figure below comes from the same place the cap does.
  const grantedCredits = async (subscriptionId: string) => Number((await cbClient.grantedCredits(subscriptionId)).credits);
  const usable = async (subscriptionId: string) => Number((await cbClient.balance(subscriptionId))?.usable ?? NaN);
  const billingView = async (tenantId: string) => (await http("GET", `${BILLING}/api/internal/billing/${tenantId}`)).data;

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

  const earlyTopup = await http("POST", `${BILLING}/api/internal/topup`, { json: { tenantId, apply: true } });
  check("B5", "top-up before subscribing refused (409 no-subscription)", earlyTopup.status === 409 && earlyTopup.data?.code === "no-subscription", `HTTP ${earlyTopup.status} ${earlyTopup.data?.code}`);

  // ── 3. checkout + subscription ──
  log("── 3. checkout and subscribe (Chargebee test site)");
  const co1 = await http("POST", `${BILLING}/api/internal/checkout`, { json: { tenantId, itemPriceId: ITEM_PRICE } });
  const co2 = await http("POST", `${BILLING}/api/internal/checkout`, { json: { tenantId, itemPriceId: ITEM_PRICE } });
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
  const hook = await http("POST", `${BILLING}/api/webhooks/chargebee`, { json: event });
  check("W2", "subscription_created webhook accepted", hook.status === 200 && hook.data?.handled !== false, JSON.stringify(hook.data));

  const acct1 = await account(tenantId);
  const bought = await grantedCredits(subscriptionId);
  const startCursor = await cursorAt(tenantId);
  check("W3", "account active, Chargebee holds the grant, and the billing cursor is set", acct1?.status === "active" && bought > 0 && startCursor != null, `status=${acct1?.status} credits=${bought} cursor=${startCursor ? new Date(startCursor).toISOString() : "none"}`);
  const baseline = Number((await team(slug))?.metadata.billing_spend_baseline ?? NaN);
  t = await team(slug);
  const expectedCap = (credits: number) => Math.round((baseline + credits * RATE) * 1e6) / 1e6;
  check("W4", `LiteLLM cap = baseline + credits × ${RATE}, no rolling reset, billing-managed`, t?.maxBudget === expectedCap(bought) && t.duration === null && t.metadata.billing_managed === true && !t.blocked, JSON.stringify({ max: t?.maxBudget, expected: expectedCap(bought), duration: t?.duration, baseline }));
  call = await llm(slug);
  check("W5", "LLM call now allowed", call.status === 200, `HTTP ${call.status} ${call.message.slice(0, 80)}`);

  const cursorBeforeDup = (await cursorAt(tenantId))!;
  const dup = await http("POST", `${BILLING}/api/webhooks/chargebee`, { json: event });
  // The replay hazard is no longer a second grant — Chargebee owns those — but
  // a cursor restarted at now(), which would silently skip everything ingested
  // in between. `ensureBillingCursor` is create-only for exactly this. Nothing
  // marks a replay as one any more (the claim row is gone) — it is acknowledged
  // like any delivery — so what is checked is that it changed nothing.
  const creditsAfterDup = await grantedCredits(subscriptionId);
  check("W6", "duplicate webhook delivery is a no-op and does not rewind the cursor", dup.status === 200 && dup.data?.received === true && (await cursorAt(tenantId)) === cursorBeforeDup && creditsAfterDup === bought, `HTTP ${dup.status} ${JSON.stringify(dup.data)} credits=${creditsAfterDup}/${bought}`);

  // The customer's browser calls this right after checkout, while Chargebee
  // also sends the webhook: both paths fire for the same term in production.
  const syncAfter = await http("POST", `${BILLING}/api/internal/sync-subscription`, { json: { tenantId } });
  const allocated2 = await grantedCredits(subscriptionId);
  t = await team(slug);
  check("W7", "webhook + post-checkout sync for the SAME term set ONE cap (no double credits)", syncAfter.status === 200 && allocated2 === bought && t?.maxBudget === expectedCap(bought), `credits=${allocated2} cap=${t?.maxBudget}`);

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
  const spans = await waitFor("spans in tenant ClickHouse DB", async () => {
    const rows = await clickhouse(`SELECT count() AS n FROM tenant_${slug}.span_nodes FINAL WHERE SpanName = 'litellm_request' AND attrs['gen_ai.cost.total_cost'] != ''`);
    return Number(rows[0]?.n ?? 0) >= realCalls + 1 ? Number(rows[0]!.n) : null;
  }, 240_000, 10_000);
  check("U2", "LiteLLM spans routed to the tenant's ClickHouse DB", !!spans, `${spans ?? 0} costed spans (incl. 1 cache hit)`);
  const usableBeforeUsage = await usable(subscriptionId);
  // Two separate things to see, because they are two separate mechanisms now:
  // the cursor moved (worker progress) and a SUCCESS row covers the range
  // (what Chargebee was told).
  const moved = await waitFor("billing advanced past the usage", async () => {
    const at = await cursorAt(tenantId);
    return at && at > startCursor! ? at : null;
  }, 300_000, 10_000);
  const billed = await lastSync(tenantId);
  check("U3", "worker billed the usage, and the cursor moved with it", !!moved && billed?.status === "SUCCESS" && billed.eventCount > 0, billed ? `to=${billed.toIngestedAt.toISOString()} amount=${billed.amount} events=${billed.eventCount}` : "billing did not move within 5 min");
  const ops = await cbClient.ledgerOperations(subscriptionId, 50);
  const captures = ops.filter((o) => String(o.type ?? "").includes("capture"));
  check("U4", "Chargebee holds the captures, under ids the worker generated", captures.length > 0, `${captures.length} capture operation(s)`);
  check("U5", "nothing is left holding the tenant once a capture settles", (await stuckRow(tenantId)) === null, `stuck=${(await stuckRow(tenantId))?.status ?? "none"}`);
  const spendAfter = await waitFor("team spend attributed", async () => { const s = (await team(slug))?.spend ?? 0; return s > before5 ? s : null; }, 60_000, 5000);
  check("U6", "master-key spend counted against the team (guard attribution)", !!spendAfter, `spend ${before5} → ${spendAfter}`);
  t = await team(slug);
  check("U7", "platform reconciler left the prepaid cap alone (> 60 s later)", t?.maxBudget === expectedCap(allocated2), `max=${t?.maxBudget}`);

  // Chargebee and LiteLLM must run down at the same rate, or one runs out
  // first. This is also what proves the cache hit was not billed: LiteLLM
  // records spend 0 for it, so any drawdown for it would show up as a gap.
  const lagMs = Number(process.env.BILLING_LAG_MS ?? 60_000);
  await sleep(Math.max(lagMs, 30_000) + 90_000); // let the last span age past the lag and be swept
  await sleep(15_000); // LiteLLM flushes team spend in batches
  const usableAfterUsage = await usable(subscriptionId);
  const litellmSpend = (await team(slug))?.spend ?? 0;
  const drawdownUsd = (usableBeforeUsage - usableAfterUsage) * RATE;
  check("U8", "Chargebee drawdown equals LiteLLM team spend — and no cache hit was billed", Math.abs(drawdownUsd - (litellmSpend - baseline)) < 1e-6, `Chargebee $${drawdownUsd} vs LiteLLM $${litellmSpend - baseline}`);

  // The cursor must be at or past every costed call old enough to have been
  // read (windows are on when each call ended), or the next read would charge
  // that usage again — or never.
  const ended = "addMilliseconds(Timestamp, if(isFinite(duration_ms) AND duration_ms > 0, toInt64(duration_ms), 0))";
  const maxEnded = await clickhouse(`SELECT max(toUnixTimestamp64Milli(${ended})) AS m FROM tenant_${slug}.span_nodes FINAL WHERE SpanName = 'litellm_request' AND attrs['gen_ai.cost.total_cost'] != '' AND JSONExtractString(attrs['hidden_params'], 'cache_key') = '' AND ${ended} <= now64(3) - INTERVAL ${Math.ceil(lagMs / 1000)} SECOND`);
  const newest = Number(maxEnded[0]?.m ?? 0);
  const cur = await cursorAt(tenantId);
  check("K1", "billing is at or past every span old enough to have been read", !!cur && !!newest && cur >= newest, `at ${cur ? new Date(cur).toISOString() : "none"} vs newest readable span ${new Date(newest).toISOString()}`);
  // The cursor is a TIME and is allowed to stand ahead of the newest span: an
  // empty window is resolved by having been read, not by having found
  // something. What it must never do is stand ahead of `now − lag`.
  check("K2", "the cursor never runs ahead of the safe processing time", !!cur && cur <= Date.now() - lagMs + 5_000, `cursor=${cur ? new Date(cur).toISOString() : "none"} safe=${new Date(Date.now() - lagMs).toISOString()}`);
  const idleBefore = await prisma.chargebeeSync.count({ where: { tenantId } });
  await sleep(90_000); // two idle ticks
  check("K3", "an idle tick writes no row at all, and still moves the cursor", (await prisma.chargebeeSync.count({ where: { tenantId } })) === idleBefore && (await cursorAt(tenantId))! >= cur!, `${idleBefore} sync rows before and after`);

  // ── 6. LiteLLM down while a top-up lands ──
  log("── 6. LiteLLM outage during a top-up budget update");
  const topInv = await cb("POST", "/invoices/create_for_charge_items_and_charges", { customer_id: tenantId, "item_prices[item_price_id][0]": TOPUP_ITEM, "item_prices[quantity][0]": 1, auto_collection: "off" });
  const inv = topInv.data?.invoice;
  if (inv?.id && inv.amount_due > 0) await cb("POST", `/invoices/${inv.id}/record_payment`, { "transaction[amount]": inv.amount_due, "transaction[payment_method]": "cash", "transaction[date]": Math.floor(Date.now() / 1000) });
  check("O1", "top-up invoice created and paid in Chargebee", topInv.status === 200 && !!inv?.id, `HTTP ${topInv.status} ${topInv.data?.message ?? inv?.id}`);

  execSync(`docker stop ${LITELLM_CONTAINER}`, { stdio: "ignore" });
  log("LiteLLM stopped");
  const topup = await http("POST", `${BILLING}/api/internal/topup`, { json: { tenantId, apply: true } });
  const acct2 = await account(tenantId);
  check("O2", "top-up applied, account held 'activating' (push failed)", topup.status === 200 && topup.data?.applied === 1 && acct2?.status === "activating", `HTTP ${topup.status} ${JSON.stringify(topup.data)} status=${acct2?.status}`);
  const view2 = await billingView(tenantId);
  check("O3", "billing page shows NO credits while activating", view2?.status === "activating" && view2?.credits?.current === "0" && (view2?.history ?? []).length === 0, JSON.stringify({ status: view2?.status, credits: view2?.credits?.current }));

  execSync(`docker start ${LITELLM_CONTAINER}`, { stdio: "ignore" });
  check("O4", "LiteLLM back up", !!(await litellmUp()));
  const active = await waitFor("worker re-activation", async () => (await account(tenantId))?.status === "active", 150_000, 5000);
  const allocated3 = await grantedCredits(subscriptionId);
  t = await team(slug);
  check("O5", "per-minute retry activated it: cap raised by the top-up, unblocked", !!active && t?.maxBudget === expectedCap(allocated3) && !t.blocked, JSON.stringify({ status: (await account(tenantId))?.status, max: t?.maxBudget, expected: expectedCap(allocated3), allocated: allocated3 }));
  check("O6", "LLM call allowed again", (await llm(slug)).status === 200);

  // ── 7. push fails but the block lands (fault injected at the push only) ──
  log("── 7. budget push fails, block succeeds");
  const hooks = gatewayBudgetHooks();
  const faulty = createAccountService({
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
  // A worker that dies between Chargebee's reply and its own UPDATE leaves the
  // row PROCESSING under an operation id that HAS been on the wire. Reproduce
  // exactly that: write the row as the worker does, capture under its id, and
  // never move the cursor.
  const leased = await waitFor("nothing holding the tenant", async () => (await stuckRow(tenantId)) === null, 120_000, 2000);
  check("L0", "tenant is clear before the fault is injected", !!leased);

  const at = (await cursorAt(tenantId))!;
  const acct3 = (await account(tenantId))!;
  const usableBefore = await usable(acct3.chargebeeSubscriptionId!);
  // A sync row left PROCESSING — exactly what a worker that died between
  // Chargebee's reply and its own UPDATE leaves behind. The window starts where
  // the cursor already is, so recovery is observable without inventing usage
  // that never happened.
  const lostId = randomUUID();
  await prisma.chargebeeSync.create({
    data: {
      id: lostId,
      tenantId,
      chargebeeSubscriptionId: acct3.chargebeeSubscriptionId,
      ledgerUnitId: acct3.ledgerUnitId,
      fromIngestedAt: new Date(at),
      toIngestedAt: new Date(at + 1),
      eventCount: 1,
      amount: "0.5",
      billedUsd: "0.0005",
      status: "PROCESSING",
    },
  });
  const landed = await cbClient.capture({ id: lostId, subscriptionId: acct3.chargebeeSubscriptionId!, unitId: acct3.ledgerUnitId!, amount: "0.5" });
  check("L1", "capture landed in Chargebee (response 'lost' — the row left PROCESSING)", landed.kind === "captured", landed.kind);

  const settled = await waitFor("recovery", async () => {
    const row = await prisma.chargebeeSync.findUnique({ where: { id: lostId } });
    return row && row.status === "SUCCESS" ? row : null;
  }, 150_000, 5000);
  const usableAfterLost = await usable(acct3.chargebeeSubscriptionId!);
  check("L2", "the worker resolved the id by looking it up, not by re-sending", settled?.status === "SUCCESS" && settled.settledAt != null, `status=${settled?.status}`);
  check("L4", "and it retried the SAME row rather than opening a second one", (await prisma.chargebeeSync.count({ where: { tenantId, fromIngestedAt: new Date(at) } })) === 1);
  check("L3", "Chargebee balance dropped by exactly 0.5 (charged once)", Math.abs(usableBefore - usableAfterLost - 0.5) < 1e-6, `usable ${usableBefore} → ${usableAfterLost}`);
  const lostOps = (await cbClient.ledgerOperations(acct3.chargebeeSubscriptionId!, 100)).filter((o) => String(o.id) === lostId);
  check("L5", "exactly one Chargebee operation exists under the recovered id", lostOps.length === 1, `${lostOps.length}`);

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
  // Usage incurred while the balance is empty. Chargebee refuses it, so the
  // cursor must stay exactly where it is — that, and nothing else, is what
  // keeps the usage: there is no held batch to requeue any more.
  const cursorWhenExhausted = (await cursorAt(tenantId))!;
  await sleep(Math.max(lagMs, 30_000) + 120_000); // let a refused sweep run at least once
  const refused = await stuckRow(tenantId);
  check("X9", "billing did not move past usage Chargebee refused, and says why", (await cursorAt(tenantId)) === cursorWhenExhausted && refused?.status === "OUT_OF_CREDITS", `status=${refused?.status} attempts=${refused?.attemptCount} error=${refused?.error?.slice(0, 60)}`);

  const inv2 = (await cb("POST", "/invoices/create_for_charge_items_and_charges", { customer_id: tenantId, "item_prices[item_price_id][0]": TOPUP_ITEM, "item_prices[quantity][0]": 1, auto_collection: "off" })).data?.invoice;
  if (inv2?.id && inv2.amount_due > 0) await cb("POST", `/invoices/${inv2.id}/record_payment`, { "transaction[amount]": inv2.amount_due, "transaction[payment_method]": "cash", "transaction[date]": Math.floor(Date.now() / 1000) });
  const topup2 = await http("POST", `${BILLING}/api/internal/topup`, { json: { tenantId, apply: true } });
  t = await team(slug);
  check("X6", "top-up reopens it: active, unblocked, reason cleared", topup2.data?.applied === 1 && (await account(tenantId))?.status === "active" && !t?.blocked && t?.metadata.billing_block_reason === undefined, JSON.stringify({ topup: topup2.data, status: (await account(tenantId))?.status, blocked: t?.blocked }));
  check("X7", "requests allowed again after the top-up", (await llm(slug)).status === 200);
  // The retained usage needs no requeueing: it is still in ClickHouse in front
  // of a cursor that never moved past it, so the next ordinary tick bills it.
  const recovered = await waitFor("retained usage billed after the top-up", async () => {
    const c = await cursorAt(tenantId);
    return c && c > cursorWhenExhausted ? c : null;
  }, 240_000, 10_000);
  const settledRefusal = refused ? await prisma.chargebeeSync.findUnique({ where: { id: refused.id } }) : null;
  check("X8", "the refused sync settled once credits returned — SAME row, no requeue step", !!recovered && (refused ? settledRefusal?.status === "SUCCESS" : true), `${new Date(cursorWhenExhausted).toISOString()} → ${recovered ? new Date(recovered).toISOString() : "unmoved"}`);
  check("X10", "and nothing is left holding the tenant", (await stuckRow(tenantId)) === null);

  // ── 10. cancellation ──
  // Chargebee refuses an immediate cancel for a subscription with credit
  // grants; it cancels at term end and sends subscription_cancelled then.
  log("── 10. cancellation (at term end)");
  const cancel = await cb("POST", `/subscriptions/${subscriptionId}/cancel_for_items`, { end_of_term: "true" });
  check("C0", "Chargebee schedules the cancellation for term end", cancel.status === 200 && cancel.data?.subscription?.status === "non_renewing", `HTTP ${cancel.status} ${cancel.data?.subscription?.status ?? cancel.data?.message}`);
  const cancelled = { ...(cancel.data?.subscription ?? subNow), status: "cancelled" }; // as delivered at term end
  const cancelHook = await http("POST", `${BILLING}/api/webhooks/chargebee`, { json: { id: `ev_e2e_${run}_cancelled`, event_type: "subscription_cancelled", content: { subscription: cancelled } } });
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
