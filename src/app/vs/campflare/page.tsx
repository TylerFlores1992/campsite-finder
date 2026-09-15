import type { Metadata } from 'next';
import ComparisonPage from '@/components/v2/ComparisonPage';
import { competitorBySlug, comparisonUrl } from '@/lib/competitors';

/**
 * /vs/campflare — one of two routes over the SAME renderer. See `src/lib/competitors.ts` for
 * the rule that governs the content: no claim about a competitor we have not verified, and
 * no competitor prices or features at all.
 */
const competitor = competitorBySlug('campflare')!;

export const metadata: Metadata = {
  title: 'CampHawk vs Campflare — campsite cancellation alerts compared',
  description:
    'How CampHawk compares if you are looking at Campflare: 14 booking systems including state ' +
    'parks, auto-carting on Recreation.gov, and an 8am hold on ReserveCalifornia. Plus the ' +
    'questions to ask any cancellation service before you pay.',
  alternates: { canonical: comparisonUrl('campflare') },
};

export default function Page() {
  return <ComparisonPage competitor={competitor} />;
}
