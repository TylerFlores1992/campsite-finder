import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SiteTypeHubPage from "@/components/v2/SiteTypeHubPage";
import { hubBySlug, typeTotals } from "@/lib/siteTypeHubs";
import { siteTypeTitle, siteTypeDescription, siteTypeUrl, SITE_NAME } from "@/lib/seo";

/**
 * /camping/group-camping — a thin route over the shared renderer.
 *
 * All three type hubs are one component driven by one config row; see
 * `components/v2/SiteTypeHubPage.tsx` and `lib/siteTypeHubs.ts`. Everything
 * specific to this type lives in SITE_TYPE_HUBS, not here.
 *
 * STATIC SEGMENT, SITTING BESIDE /camping/[state]. Next resolves a static segment
 * ahead of a dynamic sibling, so this wins; and `slugToStateCode('group-camping')` is null,
 * so even if that ever inverted the dynamic route would 404 rather than render
 * something wrong.
 */

export const revalidate = 86400;

const SLUG = "group-camping";

export async function generateMetadata(): Promise<Metadata> {
  const hub = hubBySlug(SLUG);
  if (!hub) return { title: `Not found | ${SITE_NAME}` };
  const { states, campgrounds } = await typeTotals(hub.siteType);
  const title = siteTypeTitle(hub.heading, campgrounds, states);
  const description = siteTypeDescription(hub.noun, campgrounds, states);
  const url = siteTypeUrl(SLUG);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function Page() {
  const hub = hubBySlug(SLUG);
  if (!hub) notFound();
  return <SiteTypeHubPage hub={hub} />;
}
