/**
 * Whether an org is put on the free plan, or offered the paid plans instead.
 *
 * The org's own setting (`billing_account.free_plan`) when an operator has
 * made one; otherwise FREE_PLAN_DEFAULT. An org with no billing row yet has
 * no setting, so it follows the default too.
 */
export function freePlanFor(account: { freePlan?: boolean | null } | null | undefined, byDefault: boolean): boolean {
  return account?.freePlan ?? byDefault;
}
