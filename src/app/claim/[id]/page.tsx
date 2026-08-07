import type { Metadata } from 'next';
import ClaimFlow from '@/components/v2/ClaimFlow';

/**
 * Claim a site CampHawk is holding for you.
 *
 * `noindex, nocache` — same rule as /manage/<token>: the URL carries the credentials
 * that authorise the claim, so it must never be indexed or cached by an intermediary.
 */
export const metadata: Metadata = {
  title: 'Claim your site · CampHawk',
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = 'force-dynamic';

export default async function ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { id } = await params;
  const { t } = await searchParams;
  return <ClaimFlow holdId={id} token={t ?? ''} />;
}
