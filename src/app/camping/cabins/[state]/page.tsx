import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SiteTypeStatePage from "@/components/v2/SiteTypeStatePage";
import { hubBySlug, campgroundsOfTypeInState, statesForType } from "@/lib/siteTypeHubs";
import { slugToStateCode, stateName, stateSlug } from "@/lib/coverage";
import {
  siteTypeStateTitle,
  siteTypeStateDescription,
  siteTypeStateUrl,
  SITE_NAME,
} from "@/lib/seo";

/**
 * /camping/cabins/[state] — a thin route over the shared renderer.
 *
 * generateStaticParams enumerates only the states that CLEAR the threshold, so the
 * build never prerenders a page the renderer would 404. Anything else still reaches
 * the component and 404s there, which is what keeps a hand-typed or stale URL from
 * becoming a thin indexed page.
 */

export const revalidate = 86400;

const SLUG = "cabins";

export async function generateStaticParams() {
  const hub = hubBySlug(SLUG);
  if (!hub) return [];
  const states = await statesForType(hub.siteType);
  return states
    .map(({ code }) => stateSlug(code))
    .filter((s): s is string => s !== null)
    .map((state) => ({ state }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ state: string }>;
}): Promise<Metadata> {
  const hub = hubBySlug(SLUG);
  const { state } = await params;
  const code = hub ? slugToStateCode(state) : null;
  const name = code ? stateName(code) : null;
  const list = hub && code ? await campgroundsOfTypeInState(hub.siteType, code) : null;
  if (!hub || !name || !list) return { title: `Not found | ${SITE_NAME}` };

  const title = siteTypeStateTitle(name, hub.label, list.length);
  const description = siteTypeStateDescription(name, hub.noun, list.length);
  const url = siteTypeStateUrl(SLUG, state);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function Page({ params }: { params: Promise<{ state: string }> }) {
  const hub = hubBySlug(SLUG);
  if (!hub) notFound();
  const { state } = await params;
  return <SiteTypeStatePage hub={hub} slug={state} />;
}
