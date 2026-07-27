#!/usr/bin/env tsx
/**
 * SEO regression check for campground pages.
 *
 * Two things silently regress and neither breaks a build or a test:
 *
 *   1. The page stops server-rendering. Turn CampgroundDetail back into a
 *      fetch-on-mount client component and everything still *works* — a human
 *      sees the page load fine. A crawler gets a loading skeleton. That was the
 *      state this repo was in for 8,013 pages.
 *   2. Titles or descriptions collide. Duplicate titles get folded together by
 *      Google and the pages drop out, which is exactly what "every page inherits
 *      the root layout's metadata" did.
 *
 * So this renders the real component with a real row through
 * renderToStaticMarkup and asserts the content is in the markup, then sweeps
 * every campground's generated metadata for duplicates and leaks.
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
      module.exports.ssr = async (id) => {
        const cg = await ridbSource.getDetail(id);
        if (!cg) return null;
        const html = renderToStaticMarkup(
          React.createElement(CampgroundDetail, { campgroundId: id, initialCampground: cg })
        );
        return { html, cg };
      };
      module.exports.sweep = async () => {
        const rows = await query('SELECT id, name, description, address, site_types FROM campgrounds');
        return rows.map((r) => {
          const cg = { id: r.id, name: r.name, description: r.description,
                       address: r.address ?? {}, siteTypes: r.site_types ?? [] };
          return { id: r.id, title: campgroundTitle(cg), desc: campgroundDescription(cg) };
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

const { ssr, sweep } = await import(OUT);

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

rmSync(OUTDIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
