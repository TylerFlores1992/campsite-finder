#!/usr/bin/env tsx
/**
 * SEO regression check for campground pages.
 *
 * Three things silently regress and none breaks a build or a test:
 *
 *   1. The page stops server-rendering. Turn CampgroundDetail back into a
 *      fetch-on-mount client component and everything still *works* — a human
 *      sees the page load fine. A crawler gets a loading skeleton. That was the
 *      state this repo was in for 8,013 pages.
 *   2. Titles or descriptions collide. Duplicate titles get folded together by
 *      Google and the pages drop out, which is exactly what "every page inherits
 *      the root layout's metadata" did.
 *
  *   3. Structured data starts claiming things we don't have. A stray
 *      aggregateRating or priceRange is invisible on the page and is exactly
 *      what earns a structured-data manual action — and an unescaped "<" in a
 *      third-party campground name breaks out of its own script tag.
 *
 * So this renders the real component with a real row through
 * renderToStaticMarkup, asserts the content is in the markup, then sweeps every
 * campground's generated metadata and JSON-LD for duplicates, leaks and claims
 * the catalog can't support.
 *
 * Needs DB access: NODE_USE_ENV_PROXY=1 npx tsx scripts/seo-check.mts
 */
import { build } from 'esbuild';
import { rmSync } from 'fs';
import { join, resolve, dirname } from 'path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const OUTDIR = join(ROOT, '.seo-check');
const OUT = join(OUTDIR, 'bundle.cjs');

/** Sample of rows to render — one per provider family, plus a no-description row. */
const SSR_SAMPLE = ['232447', 'ra-NY-2124'];

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// The component tree must be bundled for node: it imports CSS, Clerk and
// next/navigation, none of which resolve in a bare tsx process. Same stubs the
// screenshot harness uses.
await build({
  stdin: {
    contents: `
      const React = require('react');
      const { renderToStaticMarkup } = require('react-dom/server');
      const CampgroundDetail = require('@/components/v2/CampgroundDetail').default;
      const { ridbSource } = require('@/lib/sources/ridb');
      const { query } = require('@/lib/db/client');
      const { campgroundTitle, campgroundDescription } = require('@/lib/seo');
      const { campgroundJsonLd, campgroundBreadcrumbJsonLd, jsonLdScript } = require('@/lib/jsonld');
      const { statesWithPages, MIN_CAMPGROUNDS_FOR_STATE_PAGE } = require('@/lib/stateCampgrounds');
      const { stateSlug, stateName, slugToStateCode } = require('@/lib/coverage');
      const { stateTitle, stateDescription } = require('@/lib/seo');
      module.exports.states = async () => {
        const states = await statesWithPages();
        return { min: MIN_CAMPGROUNDS_FOR_STATE_PAGE, rows: states.map(({ code, count }) => ({
          code, count, slug: stateSlug(code), name: stateName(code),
          roundTrips: slugToStateCode(stateSlug(code)) === code,
          title: stateTitle(stateName(code), count),
          desc: stateDescription(stateName(code), count),
        })) };
      };
      module.exports.ssr = async (id) => {
        const cg = await ridbSource.getDetail(id);
        if (!cg) return null;
        const html = renderToStaticMarkup(
          React.createElement(CampgroundDetail, { campgroundId: id, initialCampground: cg })
        );
        return {
          html, cg,
          ld: campgroundJsonLd(cg),
          crumbs: campgroundBreadcrumbJsonLd(cg),
          ldScript: jsonLdScript(campgroundJsonLd(cg)),
        };
      };
      module.exports.sweep = async () => {
        const rows = await query(\`SELECT id, name, description, address, site_types, amenities,
          phone, email, pets_allowed, reservations_url,
          ST_Y(location::geometry) AS latitude, ST_X(location::geometry) AS longitude
          FROM campgrounds\`);
        return rows.map((r) => {
          const cg = { id: r.id, name: r.name, description: r.description,
                       address: r.address ?? {}, siteTypes: r.site_types ?? [],
                       amenities: r.amenities ?? [], phone: r.phone, email: r.email,
                       petsAllowed: r.pets_allowed, reservationsUrl: r.reservations_url,
                       latitude: r.latitude, longitude: r.longitude, photos: [] };
          return { id: r.id, title: campgroundTitle(cg), desc: campgroundDescription(cg),
                   ld: campgroundJsonLd(cg), script: jsonLdScript(campgroundJsonLd(cg)) };
        });
      };
    `,
    resolveDir: ROOT,
    loader: 'js',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: OUT,
  logLevel: 'error',
  external: ['react', 'react-dom', 'pg', 'undici'],
  alias: {
    '@clerk/nextjs': join(ROOT, 'scripts/harness/clerk-stub.tsx'),
    'next/navigation': join(ROOT, 'scripts/harness/next-navigation-stub.ts'),
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'empty' },
});

const { ssr, sweep, states } = await import(OUT);

console.log('\nServer-rendered HTML');
for (const id of SSR_SAMPLE) {
  const r = await ssr(id);
  if (!r) {
    console.log(`  skip  ${id} (no row)`);
    continue;
  }
  const text = r.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  console.log(`  ${id} — ${r.html.length} bytes, ${text.split(' ').length} words`);
  check('has an <h1>', /<h1[^>]*>/.test(r.html));
  check('campground name is in the markup', text.includes(r.cg.name));
  check('no loading skeleton', !/animate-pulse/.test(r.html));
  check('substantial content', text.length > 200, `${text.length} chars`);
}

console.log('\nStructured data');
{
  const r = await ssr(SSR_SAMPLE[0]);
  if (r) {
    check('Campground @type', r.ld['@type'] === 'Campground');
    check('has geo coordinates', typeof r.ld.geo?.latitude === 'number');
    check('address has a country', r.ld.address?.addressCountry === 'US');
    check('breadcrumb has 2+ levels', r.crumbs.itemListElement.length >= 2);
    check('script payload has no raw <', !r.ldScript.includes('<'));
    check('script payload parses back', (() => {
      try { return JSON.parse(r.ldScript.replace(/\\u003c/g, '<'))['@type'] === 'Campground'; }
      catch { return false; }
    })());
    console.log(`  fields emitted: ${Object.keys(r.ld).join(', ')}`);
  }
}

console.log('\nMetadata across the catalog');
const all = await sweep();
const titles = new Map<string, string[]>();
const descs = new Set<string>();
let leaks = 0;
let emptyDesc = 0;
for (const r of all) {
  titles.set(r.title, [...(titles.get(r.title) ?? []), r.id]);
  descs.add(r.desc);
  if (/<[a-zA-Z/]|&[a-zA-Z]+;/.test(r.title + r.desc)) leaks++;
  if (!r.desc || r.desc.length < 50) emptyDesc++;
}
const collisions = [...titles.values()].filter((v) => v.length > 1);
const collidingPages = collisions.reduce((a, v) => a + v.length, 0);

console.log(`  ${all.length} campgrounds`);
check('titles are near-unique', collidingPages / all.length < 0.01,
  `${collidingPages} pages share ${collisions.length} titles`);
check('descriptions are near-unique', descs.size / all.length > 0.95,
  `${descs.size} unique`);
check('no HTML or entities in metadata', leaks === 0, `${leaks} leaking`);
check('no empty descriptions', emptyDesc === 0, `${emptyDesc} under 50 chars`);

// Structured data must never carry a value we don't have, and must never break
// out of its own script tag.
let fabricated = 0;
let unescaped = 0;
let noGeo = 0;
let badRegion = 0;
let unparseable = 0;
const REGION_OK = /^[A-Z]{2}$/;
for (const r of all) {
  const ld = r.ld as Record<string, unknown>;
  if ('aggregateRating' in ld || 'priceRange' in ld || 'review' in ld) fabricated++;
  if (r.script.includes('<')) unescaped++;
  if (!ld.geo) noGeo++;
  const region = (ld.address as Record<string, string> | undefined)?.addressRegion;
  if (region && !REGION_OK.test(region)) badRegion++;
  try { JSON.parse(r.script.replace(/\\u003c/g, '<')); } catch { unparseable++; }
}
check('no fabricated ratings or prices', fabricated === 0, `${fabricated} rows`);
check('no unescaped < in any payload', unescaped === 0, `${unescaped} rows`);
check('every row has geo', noGeo === 0, `${noGeo} without`);
check('addressRegion is always a 2-letter code', badRegion === 0, `${badRegion} odd`);
check('every payload is valid JSON', unparseable === 0, `${unparseable} broken`);

console.log('\nState landing pages');
{
  // Named rather than nine inline `any`s. `states()` is local to this script and this is
  // the only consumer, so the shape belongs here where a change to it fails loudly.
  type StateRow = {
    code: string; slug: string; title: string; desc: string;
    count: number; roundTrips: boolean;
  };
  const { min, rows }: { min: number; rows: StateRow[] } = await states();
  console.log(`  ${rows.length} states qualify (>= ${min} campgrounds), ` +
    `${rows.reduce((a: number, r: StateRow) => a + r.count, 0).toLocaleString()} campgrounds linked`);
  check('every slug round-trips back to its code', rows.every((r: StateRow) => r.roundTrips),
    rows.filter((r: StateRow) => !r.roundTrips).map((r: StateRow) => r.code).join(' '));
  check('no state is below the threshold', rows.every((r: StateRow) => r.count >= min));
  check('titles are unique', new Set(rows.map((r: StateRow) => r.title)).size === rows.length);
  check('descriptions are unique', new Set(rows.map((r: StateRow) => r.desc)).size === rows.length);
  check('no description over 160 chars', rows.every((r: StateRow) => r.desc.length <= 160),
    `longest ${Math.max(...rows.map((r: StateRow) => r.desc.length))}`);
  const eg = rows[0];
  console.log(`  e.g. /camping/${eg.slug} — ${eg.count.toLocaleString()} campgrounds`);
  console.log(`       ${eg.title}`);
}

rmSync(OUTDIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
