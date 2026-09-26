/**
 * Pure classification for the admin Subscribers list — NO imports, on purpose.
 *
 * `subscribers.ts` reaches Stripe through `lib/stripe-plans`, which is `server-only` and
 * throws when imported from a test. Keeping the rules that decide which group a person is
 * in here means `subscriber-group.test.mts` exercises the REAL function rather than a
 * copy of it.
 */

export type SubscriberGroup = 'active' | 'trialing' | 'cancelling' | 'lapsed';

export const SUBSCRIBER_GROUPS: ReadonlyArray<{ key: SubscriberGroup; label: string }> = [
  { key: 'active', label: 'Active' },
  { key: 'trialing', label: 'Trialing' },
  { key: 'cancelling', label: 'Cancelling' },
  { key: 'lapsed', label: 'Lapsed' },
];

/**
 * Which group a subscription row belongs in.
 *
 * `cancelling` comes from the ONE SQL definition (`CANCELLING` in queries.ts), which
 * already treats EITHER of Stripe's fields as a pending cancellation and already refuses
 * dead rows. It is checked first because a cancelling subscriber is still `active` (or
 * `trialing`) in Stripe until the day they go — reading the status first is exactly how
 * the one real cancelling subscriber went invisible.
 *
 * TRIALING IS A SUBSCRIBER. The MRR tile lists only `active` from Stripe; that is a
 * revenue figure, not a roster, and this must not copy its filter.
 *
 * Everything that is not live — canceled, expired, past_due, unpaid, incomplete, or a
 * status we have never seen — is `lapsed`. The row keeps its real status word beside the
 * group, so `past_due` is never disguised as `canceled`.
 */
export function subscriberGroup(row: { status: string | null; cancelling: boolean }): SubscriberGroup {
  if (row.cancelling) return 'cancelling';
  if (row.status === 'trialing') return 'trialing';
  if (row.status === 'active') return 'active';
  return 'lapsed';
}

/** Where the subscription was bought. `provider` is 'stripe' | 'apple' | 'google'
 *  (migration 071), and anything else is shown verbatim rather than guessed at. */
export function sourceLabel(provider: string | null): string {
  switch (provider) {
    case 'stripe': return 'Web (Stripe)';
    case 'apple': return 'App Store (RevenueCat)';
    case 'google': return 'Google Play (RevenueCat)';
    default: return provider ? provider : 'unknown';
  }
}
