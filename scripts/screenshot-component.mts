#!/usr/bin/env tsx
/**
 * Component-isolation screenshot harness.
 *
 * Renders ONE React component into a bare static page (project Tailwind, no Next,
 * no Clerk, no data, no auth) served on a plain localhost port, then screenshots it
 * with the pre-installed Chromium. This is the reliable way to capture front-end
 * layout from inside the sandbox: the live site is unreachable (the agent proxy
 * resets browser TLS) and the full Next app drags in Clerk's dev-browser redirect —
 * isolation sidesteps both because nothing leaves localhost and no TLS is in the path.
 *
 * Scope: pure presentational/layout checks (spacing, alignment, sizing, responsive).
 * It does NOT exercise real data, auth, or full-page composition.
 *
 * Usage:
 *   npx tsx scripts/screenshot-component.mts <spec> [--out=file.png] [--width=1440] [--height=900] [--wait=1500]
 *
 * <spec> is a preset name from PRESETS below (e.g. "search-bar"), or an ad-hoc
 * "path/to/Component.tsx" (default export) with no props.
 *
 * Chromium must be reachable via playwright-core (a devDependency) + the image's
 * pre-installed browser at /opt/pw-browsers.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import http from 'http';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// A preset names the component to import and a bit of JSX to render it with realistic
// props. Add entries here as new components need eyeballing.
interface Preset {
  label: string;
  // ESM import + a JSX expression rendered inside the frame. `React` is in scope.
  entry: string;
  // Optional wrapper classes around the mount (defaults to a centered app-like frame).
  frame?: string;
}

const PRESETS: Record<string, Preset> = {
  'search-bar': {
    label: 'SearchBar (landing search bar)',
    entry: `import SearchBar from '@/components/SearchBar';
      export const node = <SearchBar onSearch={() => {}} onTonight={() => {}} onThisWeekend={() => {}} />;`,
    // The real bar sits on the cream hero over a max-width container.
    frame: 'max-w-3xl w-full mx-auto',
  },
  'favorites-panel': {
    label: 'FavoritesPanel (subscriber saved-campgrounds slide-over)',
    // Stub fetch so the panel renders populated instead of its empty state.
    entry: `import FavoritesPanel from '@/components/FavoritesPanel';
      if (typeof window !== 'undefined') {
        window.fetch = async () => ({ ok: true, json: async () => ({ favorites: [
          { id: '1', name: 'Kirk Creek Campground', city: 'Big Sur', state: 'CA', latitude: 0, longitude: 0, source: 'ridb', reservations_url: null },
          { id: '2', name: 'Wrights Beach', city: 'Bodega Bay', state: 'CA', latitude: 0, longitude: 0, source: 'reservecalifornia', reservations_url: null },
          { id: '3', name: 'Point Reyes Hike-In', city: 'Point Reyes', state: 'CA', latitude: 0, longitude: 0, source: 'ridb', reservations_url: null },
        ] }) });
      }
      export const node = <FavoritesPanel onClose={() => {}} onSelect={() => {}} />;`,
    frame: 'w-full h-full',
  },
  'manage-watch': {
    label: 'ManageWatch (per-watch manage page)',
    entry: `import ManageWatch from '@/components/ManageWatch';
      if (typeof window !== 'undefined') {
        window.fetch = async (url) => {
          const u = String(url);
          if (u.includes('/availability')) {
            return { ok: true, status: 200, json: async () => ({ campsites:
              ['A01','A02','A12','A14','B03','B07','B12','C05','C09'].map((id, i) => ({ campsiteId: id, campsiteName: 'Site ' + id, loop: id[0] === 'A' ? 'Ocean Loop' : id[0] === 'B' ? 'Creek Loop' : 'Ridge Loop' })) }) };
          }
          return { ok: true, status: 200, json: async () => ({
            watch: { id: 'w1', campground_id: '233116', campground_name: 'Kirk Creek Campground', source: 'ridb', reservations_url: null, latitude: 35.99, longitude: -121.49, start_date: '2026-09-04', end_date: '2026-09-07', min_nights: 2, flex_nights: 2, flex_days: 'weekend', site_type: null, active: true, auto_cart: true, muted_site_ids: ['A14'] },
            alerts: [
              { created_at: '2026-08-20T15:00:00Z', channel: 'sms', status: 'sent', site_name: 'A12', dates: ['2026-09-04','2026-09-05'], kind: 'available' },
              { created_at: '2026-08-18T09:00:00Z', channel: 'email', status: 'sent', site_name: 'A14', dates: ['2026-09-06'], kind: 'coming_soon' },
            ],
            sites: [ { id: 'A12', name: 'Site A12' }, { id: 'A14', name: 'Site A14' } ],
          }) };
        };
      }
      export const node = <ManageWatch token="demo" />;`,
    frame: 'max-w-lg w-full mx-auto',
  },
  'ch-primitives': {
    label: 'Redesign primitives (Button / Chip / Tag / Card / Collapsible)',
    // Every variant of every phase-2 primitive on one sheet, on the ch-paper
    // ground so the surfaces read correctly. Collapsible is rendered both open
    // and closed since the transition is the thing worth eyeballing.
    entry: `import Button from '@/components/ui/Button';
      import Chip from '@/components/ui/Chip';
      import Tag from '@/components/ui/Tag';
      import Card from '@/components/ui/Card';
      import Collapsible from '@/components/ui/Collapsible';
      const H = ({ children }) => <div className="text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted mb-2 mt-5 first:mt-0">{children}</div>;
      function Sheet() {
        const [sel, setSel] = React.useState(['Tent']);
        const flip = (v) => setSel((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v]);
        return (
          <div className="bg-ch-paper p-6 rounded-ch-card font-ch-body text-ch-ink">
            <H>Button — primary / quiet / cart / warn</H>
            <div className="flex flex-wrap gap-2 items-center">
              <Button variant="primary">Start watching</Button>
              <Button variant="quiet">See full calendar</Button>
              <Button variant="cart">Check out on Recreation.gov</Button>
              <Button variant="warn">Reconnect Recreation.gov</Button>
              <Button variant="primary" disabled>Disabled</Button>
            </div>
            <H>Button — sizes</H>
            <div className="flex flex-wrap gap-2 items-center">
              <Button size="sm">Small</Button><Button size="md">Medium</Button><Button size="lg">Large</Button>
            </div>
            <H>Chip — toggles</H>
            <div className="flex flex-wrap gap-1.5">
              {['Tent','RV','Cabin','Group','Hookups','Pets OK','Water nearby'].map((t) => (
                <Chip key={t} selected={sel.includes(t)} onClick={() => flip(t)}>{t}</Chip>
              ))}
            </div>
            <H>Tag — status and source</H>
            <div className="flex flex-wrap gap-1.5 items-center">
              <Tag kind="open">Site open</Tag>
              <Tag kind="watch">Watching</Tag>
              <Tag kind="cart">In your cart</Tag>
              <Tag kind="paused">Paused</Tag>
              <Tag kind="alert">Action needed</Tag>
              <Tag kind="src">Recreation.gov</Tag>
              <Tag kind="src">Washington · GoingToCamp</Tag>
            </div>
            <H>Card — default / hit / warn / paused</H>
            <div className="grid grid-cols-2 gap-3">
              {[['default','Watching'],['hit','Site open'],['warn','Action needed'],['paused','Paused']].map(([st, lab]) => (
                <Card key={st} state={st}>
                  <div data-card-dim>
                    <div className="mb-2 flex gap-1.5">
                      <Tag kind={st === 'hit' ? 'open' : st === 'warn' ? 'alert' : st === 'paused' ? 'paused' : 'watch'}>{lab}</Tag>
                      <Tag kind="src">Recreation.gov</Tag>
                    </div>
                    <div className="font-ch-display text-ch-park font-bold tracking-[-.02em]">Kirk Creek Campground</div>
                    <div className="text-ch-meta text-ch-muted mt-0.5">Los Padres NF · Big Sur, CA</div>
                    <div className="text-ch-body font-bold text-ch-ink-2 mt-2.5">Fri Aug 14 – Sun Aug 16, 2026</div>
                  </div>
                  <div className="mt-3 pt-2.5 border-t border-ch-line flex gap-1.5">
                    <Button variant="quiet" size="sm" className="flex-1">Calendar</Button>
                    <Button variant="quiet" size="sm" className="flex-1">{st === 'paused' ? 'Resume' : 'Pause'}</Button>
                  </div>
                </Card>
              ))}
            </div>
            <H>Collapsible — closed and open</H>
            <div className="grid gap-3">
              <Collapsible label="Filters" summary="all sites">
                <div className="text-ch-body text-ch-ink-2">Nothing selected means every site counts.</div>
              </Collapsible>
              <Collapsible label="Alert history" summary="3 this month" defaultOpen>
                <div className="text-ch-body text-ch-ink-2">
                  Kirk Creek · Site 22 — today 6:42 AM<br />
                  Pfeiffer Big Sur · Site 118 — Aug 9, 11:20 PM
                </div>
              </Collapsible>
            </div>
          </div>
        );
      }
      export const node = <Sheet />;`,
    frame: 'max-w-2xl w-full mx-auto',
  },
  'v2-available': {
    label: 'v2 Available now (search rail + results)',
    // Drives the REAL flow rather than faking state: types a place, picks the
    // suggestion, submits, and lets the component call the mocked endpoints. That
    // exercises the debounce, the request guard and the result mapping.
    entry: `import AvailableNow from '@/components/v2/AvailableNow';
      const mk = (id, name, city, state, source, dist, avail, extra = {}) => ({
        id, source, name, description: null, latitude: 36, longitude: -121.5,
        address: { city, state }, amenities: [], activities: [], environmentTags: [],
        siteTypes: ['tent'], reservable: true, reservationsUrl: null, phone: null, email: null,
        adaAccessible: false, petsAllowed: true, photos: [], lastSyncedAt: null,
        distanceMiles: dist, hasAvailability: avail, ...extra,
      });
      const CAMPGROUNDS = [
        mk('233116', 'Kirk Creek Campground', 'Big Sur', 'CA', 'ridb', 4, true,
           { likelihood: { rate: 0.34, label: '3–6 weeks out', samples: 91 } }),
        mk('rc-783', 'Limekiln State Park', 'Big Sur', 'CA', 'reservecalifornia', 11, true),
        mk('gtc-WA--2147483647', 'Cape Disappointment', 'Ilwaco', 'WA', 'goingtocamp', 18, false),
        mk('tnsc-SC-aiken', 'Aiken State Park', 'Windsor', 'SC', 'tnsc', 23, false),
        mk('232447', 'Ponderosa Campground', 'Big Sur', 'CA', 'ridb', 27, undefined),
        mk('ra-NY-12', 'Allegany State Park', 'Salamanca', 'NY', 'reserveamerica', 31, false),
      ];
      if (typeof window !== 'undefined') {
        window.fetch = async (url) => {
          const u = String(url);
          if (u.includes('/api/suggest')) {
            return { ok: true, json: async () => ({ campgrounds: [
              { id: 'x', name: 'Big Sur', city: 'Big Sur', state: 'CA', latitude: 36.27, longitude: -121.81 },
            ] }) };
          }
          return { ok: true, json: async () => ({ campgrounds: CAMPGROUNDS, total: CAMPGROUNDS.length }) };
        };
      }
      function Harness() {
        React.useEffect(() => {
          const setValue = (el, v) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          };
          const t1 = setTimeout(() => {
            const input = document.getElementById('v2-where');
            if (input) setValue(input, 'Big Sur');
          }, 200);
          const t2 = setTimeout(() => {
            const sug = document.querySelector('ul li button');
            if (sug) sug.click();
          }, 700);
          const t3 = setTimeout(() => {
            const btn = Array.from(document.querySelectorAll('button'))
              .find((b) => b.textContent.trim() === 'Search');
            if (btn) btn.click();
          }, 1000);
          return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
        }, []);
        return <AvailableNow />;
      }
      export const node = <div className="bg-ch-paper font-ch-body text-ch-ink"><Harness /></div>;`,
    frame: 'w-full',
  },
  'v2-detail': {
    label: 'v2 Campground detail (calendar + open sites + about)',
    // Mocks both endpoints the page calls and auto-taps an open day so the shot
    // captures the per-site list rather than the "Pick a day" resting state.
    entry: `import CampgroundDetail from '@/components/v2/CampgroundDetail';
      const now = new Date();
      const month = now.toISOString().slice(0, 7);
      const d = (n) => month + '-' + String(n).padStart(2, '0');
      const OPEN_DAYS = [3, 4, 9, 14, 15, 21, 22, 23, 28];
      const site = (id, name, loop, type, days) => ({
        campsiteId: id, campsiteName: name, campsiteType: type, loop,
        availability: days.map((n) => ({ date: d(n), status: 'available', minStay: null })),
      });
      const CAMPSITES = [
        site('A22', 'Site 22', 'Ocean Loop', 'TENT', [3, 14, 15, 22]),
        site('A14', 'Site 14', 'Ocean Loop', 'RV', [3, 4, 14, 21]),
        site('B07', 'Site 7', 'Creek Loop', 'RV', [9, 14, 23, 28]),
        site('C31', 'Site 31', 'Ridge Loop', 'TENT', [4, 15, 22]),
      ];
      if (typeof window !== 'undefined') {
        window.fetch = async (url) => {
          const u = String(url);
          if (u.includes('/availability')) {
            return { ok: true, status: 200, json: async () => ({
              campgroundId: '233116', month, campsites: CAMPSITES, availableCount: CAMPSITES.length }) };
          }
          return { ok: true, status: 200, json: async () => ({ campground: {
            id: '233116', source: 'ridb', name: 'Kirk Creek Campground',
            description: 'Perched on a bluff above the Pacific in Los Padres National Forest, every site here looks west over the water. No hookups; vault toilets and drinking water on site.',
            latitude: 35.99, longitude: -121.49,
            address: { city: 'Big Sur', state: 'CA' },
            amenities: ['drinking water', 'toilets', 'fire rings', 'picnic tables'],
            activities: [], environmentTags: ['ocean'], siteTypes: ['tent', 'rv'],
            reservable: true, reservationsUrl: null, phone: '(805) 434-1996', email: null,
            adaAccessible: false, petsAllowed: true,
            photos: [
              { url: 'https://placehold.co/600x400/24382A/E4F1E8?text=Bluff', title: 'Bluff' },
              { url: 'https://placehold.co/300x300/3B5A43/E4F1E8?text=Site+22' },
              { url: 'https://placehold.co/300x300/5E8C6B/16291F?text=Loop+A' },
            ],
            lastSyncedAt: null,
          }, campsites: [] }) };
        };
      }
      function Harness() {
        React.useEffect(() => {
          const t = setTimeout(() => {
            const btn = document.querySelector('button[data-avail-day="' + d(14) + '"]');
            if (btn) btn.click();
          }, 700);
          return () => clearTimeout(t);
        }, []);
        return <CampgroundDetail campgroundId="233116" />;
      }
      export const node = <div className="bg-ch-paper font-ch-body text-ch-ink"><Harness /></div>;`,
    frame: 'w-full',
  },
  'v2-watches': {
    label: 'v2 Watches (quota, outage banner, all card states)',
    // Mocks /api/watches and /api/health/status. ReserveCalifornia is reported
    // down so the outage banner and the "checks paused" card both appear.
    entry: `import WatchesList from '@/components/v2/WatchesList';
      const hourAgo = new Date(Date.now() - 12 * 60 * 1000).toISOString();
      const WATCHES = [
        { id: 'w1', campground_id: '233116', campground_name: 'Kirk Creek Campground',
          campground_source: 'ridb', start_date: '2026-08-14', end_date: '2026-08-16',
          flex_nights: null, flex_days: null, site_type: null, auto_cart: true, active: true,
          notification_sent_at: hourAgo, manage_url: '/manage/demo',
          likelihood: { rate: 0.34, samples: 91 } },
        { id: 'w2', campground_id: 'rc-783', campground_name: 'Pfeiffer Big Sur',
          campground_source: 'reservecalifornia', start_date: '2026-09-04', end_date: '2026-09-07',
          flex_nights: null, flex_days: null, site_type: null, auto_cart: false, active: true,
          notification_sent_at: null, manage_url: '/manage/demo' },
        { id: 'w3', campground_id: 'gtc-WA--2147483647', campground_name: 'Cape Disappointment',
          campground_source: 'goingtocamp', start_date: '2026-10-01', end_date: '2026-10-31',
          flex_nights: 2, flex_days: 'weekend', site_type: 'rv', auto_cart: false, active: true,
          notification_sent_at: null, muted_site_ids: ['A14'], manage_url: '/manage/demo' },
        { id: 'w4', campground_id: '232447', campground_name: 'Bridalveil Creek',
          campground_source: 'ridb', start_date: '2026-11-06', end_date: '2026-11-08',
          flex_nights: null, flex_days: null, site_type: null, auto_cart: false, active: false,
          notification_sent_at: null, manage_url: '/manage/demo' },
      ];
      if (typeof window !== 'undefined') {
        window.fetch = async (url) => {
          const u = String(url);
          if (u.includes('/api/health/status')) {
            return { ok: true, status: 200, json: async () => ({ checks: [
              { name: 'detect:ridb', ok: true, ageSeconds: 40 },
              { name: 'detect:reservecalifornia', ok: false, ageSeconds: 2400 },
              { name: 'detect:goingtocamp', ok: true, ageSeconds: 55 },
            ] }) };
          }
          return { ok: true, status: 200, json: async () => ({ watches: WATCHES }) };
        };
      }
      export const node = (
        <div className="bg-ch-paper font-ch-body text-ch-ink p-6">
          <h1 className="mb-4 font-ch-display text-ch-title font-extrabold tracking-[-.03em]">Your watches</h1>
          <WatchesList />
        </div>
      );`,
    frame: 'w-full',
  },
  'v2-new-watch': {
    label: 'v2 New watch (flexible + auto-cart trust panel)',
    // Pre-selects a rec.gov campground so auto-cart and the trust panel render,
    // then flips to Flexible and opens the saved-login disclosure — the block
    // that had to be rewritten because the mockup's copy was factually wrong.
    entry: `import NewWatch from '@/components/v2/NewWatch';
      import TrustPanel from '@/components/v2/TrustPanel';
      if (typeof window !== 'undefined') {
        window.fetch = async (url) => {
          const u = String(url);
          if (u.includes('/api/suggest')) return { ok: true, json: async () => ({ campgrounds: [] }) };
          return { ok: true, status: 200, json: async () => ({ campground: {
            id: '233116', source: 'ridb', name: 'Kirk Creek Campground', description: null,
            latitude: 36, longitude: -121, address: { city: 'Big Sur', state: 'CA' },
            amenities: [], activities: [], environmentTags: [], siteTypes: ['tent'],
            reservable: true, reservationsUrl: null, phone: null, email: null,
            adaAccessible: false, petsAllowed: true, photos: [], lastSyncedAt: null,
          }, campsites: [] }) };
        };
      }
      function Harness() {
        React.useEffect(() => {
          const t = setTimeout(() => {
            const flex = Array.from(document.querySelectorAll('button'))
              .find((b) => b.textContent.trim() === 'Flexible');
            if (flex) flex.click();
            const saved = Array.from(document.querySelectorAll('button[aria-expanded]'))
              .find((b) => b.textContent.includes('Keep me signed in'));
            if (saved) saved.click();
          }, 600);
          return () => clearTimeout(t);
        }, []);
        return (
          <>
            <NewWatch initialCampgroundId="233116" initialStart="2026-10-01" initialEnd="2026-10-31" />
            <div className="mt-6">
              <div className="text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted mb-2">
                Trust panel with saved-login enabled (rewritten copy)
              </div>
              <TrustPanel savedLogin />
            </div>
          </>
        );
      }
      export const node = <div className="bg-ch-paper font-ch-body text-ch-ink p-6"><Harness /></div>;`,
    frame: 'w-full',
  },
  'ch-logo': {
    label: 'HawkGlyph vs the full badge at small sizes',
    // The point of the glyph is that it survives favicon size. Shown against the
    // existing HawkMark at the same sizes so the difference is judgeable.
    entry: `import HawkGlyph from '@/components/ui/HawkGlyph';
      import { HawkMark } from '@/components/Logo';
      const SIZES = [64, 48, 32, 24, 16];
      const Row = ({ title, render }) => (
        <div className="mb-5">
          <div className="text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted mb-2">{title}</div>
          <div className="flex items-end gap-4">
            {SIZES.map((s) => (
              <div key={s} className="text-center">
                <div className="flex items-end justify-center" style={{ height: 64 }}>{render(s)}</div>
                <div className="text-[10px] text-ch-muted mt-1">{s}px</div>
              </div>
            ))}
          </div>
        </div>
      );
      export const node = (
        <div className="bg-ch-paper p-6 rounded-ch-card font-ch-body text-ch-ink">
          <Row title="Existing badge (HawkMark) — dissolves below ~40px"
               render={(s) => <HawkMark size={s} />} />
          <Row title="New HawkGlyph — badge variant (app icon)"
               render={(s) => <HawkGlyph size={s} variant="badge" />} />
          <Row title="New HawkGlyph — bare silhouette, inherits colour"
               render={(s) => <HawkGlyph size={s} className="text-ch-green" />} />
          <div className="flex items-center gap-2 border-t border-ch-line pt-4">
            <HawkGlyph size={22} className="text-ch-green" />
            <span className="font-ch-display text-[19px] font-extrabold tracking-[-.025em]">CampHawk</span>
            <span className="text-ch-fine text-ch-muted ml-2">← in-header lockup at 22px</span>
          </div>
        </div>
      );`,
    frame: 'max-w-lg w-full mx-auto',
  },
  'ch-controls': {
    label: 'Redesign shared controls (DatePicker / NightsPicker / FilterPanel)',
    // DatePicker is shown mid-selection with the check-in in the PREVIOUS month —
    // the case the old {y,m,a,b} model could not represent at all. FilterPanel is
    // shown with RV active so the conditional rig-length row is visible.
    entry: `import DatePicker from '@/components/ui/DatePicker';
      import NightsPicker from '@/components/ui/NightsPicker';
      import FilterPanel, { EMPTY_FILTERS } from '@/components/ui/FilterPanel';
      const H = ({ children }) => <div className="text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted mb-2 mt-5 first:mt-0">{children}</div>;
      function Sheet() {
        const [range, setRange] = React.useState({ start: '2026-08-29', end: '2026-09-01' });
        const [nights, setNights] = React.useState(2);
        const [weekend, setWeekend] = React.useState(true);
        const [filters, setFilters] = React.useState({ ...EMPTY_FILTERS, siteType: 'rv', rvLength: 32, pets: true });
        return (
          <div className="bg-ch-paper p-6 rounded-ch-card font-ch-body text-ch-ink">
            <H>DatePicker — Aug 29 → Sep 1, viewed from August (runs out)</H>
            <DatePicker value={range} onChange={setRange} label="Trip dates"
              minDate="2026-07-01" defaultMonth="2026-08-01" open onOpenChange={() => {}} />
            <H>…the same range, viewed from September (carries in)</H>
            <DatePicker value={range} onChange={setRange} label="Trip dates"
              minDate="2026-07-01" defaultMonth="2026-09-01" open onOpenChange={() => {}} />
            <H>DatePicker — collapsed, with a flexible-window meta line</H>
            <DatePicker value={{ start: '2026-10-01', end: '2026-10-31' }} onChange={() => {}}
              label="Watch window" meta="any 2-night weekend in this window" minDate="2026-07-01" />
            <H>NightsPicker — flexible stay, weekends only</H>
            <NightsPicker nights={nights} onNightsChange={setNights}
              weekendsOnly={weekend} onWeekendsOnlyChange={setWeekend} />
            <H>FilterPanel — open, RV selected (rig length revealed)</H>
            <FilterPanel value={filters} onChange={setFilters} defaultOpen />
          </div>
        );
      }
      export const node = <Sheet />;`,
    frame: 'max-w-md w-full mx-auto',
  },
  'avail-usedirect': {
    label: 'AvailabilityCalendar (ReserveCalifornia — open-site dropdown)',
    // Mocks a UseDirect availability response with several sites open on a near day,
    // then auto-taps that day so the shot captures the open-site picker (the thing the
    // rec.gov→UseDirect dropdown change added). Sites share the park link by design.
    entry: `import AvailabilityCalendar from '@/components/AvailabilityCalendar';
      const now = new Date();
      const month = now.toISOString().slice(0, 7);
      const iso = (d) => d.toISOString().slice(0, 10);
      const day = (n) => { const d = new Date(now); d.setDate(now.getDate() + n); return iso(d); };
      const mk = (id, name, loop, type, dates) => ({ campsiteId: id, campsiteName: name, campsiteType: type, loop, availability: dates.map((dt) => ({ date: dt, status: 'available', minStay: null })) });
      const campsites = [
        mk('72101', 'Oceanfront 12', 'Sea Breeze Loop', 'RV', [day(3), day(4)]),
        mk('72102', 'Oceanfront 14', 'Sea Breeze Loop', 'TENT', [day(3), day(5)]),
        mk('72103', 'Redwood 07', 'Canopy Loop', 'TENT', [day(3), day(10)]),
        mk('72104', 'Redwood 22', 'Canopy Loop', 'RV', [day(4), day(11)]),
        mk('72105', 'Meadow 03', null, 'TENT', [day(3)]),
      ];
      if (typeof window !== 'undefined') {
        window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ campgroundId: 'rc-783', month, campsites, availableCount: campsites.length }) });
      }
      function Harness() {
        React.useEffect(() => {
          const t = setTimeout(() => {
            const btns = Array.from(document.querySelectorAll('button[data-avail-day]'));
            const target = btns.find((b) => b.getAttribute('data-avail-day') === day(3)) || btns[0];
            if (target) target.click();
          }, 500);
          return () => clearTimeout(t);
        }, []);
        return <AvailabilityCalendar campgroundId="rc-783" month={month} source="reservecalifornia" reservationsUrl="https://www.reservecalifornia.com/park/622" providerName="ReserveCalifornia" />;
      }
      export const node = <Harness />;`,
    frame: 'max-w-md w-full mx-auto',
  },
};

function parseArgs() {
  const a = process.argv.slice(2);
  const spec = a.find((x) => !x.startsWith('--'));
  const get = (k: string, d: string) => {
    const h = a.find((x) => x.startsWith(`--${k}=`));
    return h ? h.split('=').slice(1).join('=') : d;
  };
  return {
    spec,
    out: get('out', join(ROOT, 'screenshot.png')),
    width: Number(get('width', '1440')),
    height: Number(get('height', '900')),
    wait: Number(get('wait', '1500')),
  };
}

function resolveEntry(spec: string | undefined): { entry: string; frame: string; label: string } {
  if (!spec) {
    const names = Object.keys(PRESETS).join(', ');
    throw new Error(`No component spec given. Presets: ${names}. Or pass a path to a .tsx with a default export.`);
  }
  const preset = PRESETS[spec];
  if (preset) return { entry: preset.entry, frame: preset.frame ?? 'max-w-3xl w-full mx-auto', label: preset.label };
  // Ad-hoc path → import its default export, no props.
  const importPath = spec.startsWith('@/') || spec.startsWith('.') ? spec : `@/${spec.replace(/^src\//, '')}`;
  return {
    entry: `import C from '${importPath.replace(/\.tsx?$/, '')}';\n      export const node = <C />;`,
    frame: 'max-w-3xl w-full mx-auto',
    label: spec,
  };
}

async function main() {
  const { spec, out, width, height, wait } = parseArgs();
  const { entry, frame, label } = resolveEntry(spec);
  const work = mkdtempSync(join(tmpdir(), 'shot-'));
  console.log(`[shot] ${label} → ${out}`);

  // 1. Bundle the component + a mount into a browser IIFE. Alias @/ → src/, shim
  //    `process.env` so NEXT_PUBLIC_* references don't crash in the browser.
  const entrySource = `import React from 'react';
     import { createRoot } from 'react-dom/client';
     ${entry}
     createRoot(document.getElementById('root')!).render(<React.StrictMode>{node}</React.StrictMode>);`;
  const bundle = await build({
    // stdin + resolveDir=ROOT so bare imports (react, lucide, @/…) resolve from the
    // project's node_modules, not the temp dir.
    stdin: { contents: entrySource, resolveDir: ROOT, loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true,
    format: 'iife',
    write: false,
    jsx: 'automatic',
    absWorkingDir: ROOT,
    alias: {
      '@': join(ROOT, 'src'),
      // Components outside a Next app have no AppRouterContext; the real
      // useRouter() throws and the screenshot comes out blank.
      'next/navigation': join(ROOT, 'scripts/harness/next-navigation-stub.ts'),
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'window.process = window.process || { env: {} };' },
    logLevel: 'silent',
  });
  const js = bundle.outputFiles[0].text;

  // 2. Compile the project's Tailwind (globals.css carries the brand @theme palette;
  //    v4 auto-scans src/ for used classes, so every component's classes are covered).
  const globals = readFileSync(join(ROOT, 'src/app/globals.css'), 'utf-8');
  const css = (await postcss([tailwind()]).process(globals, { from: join(ROOT, 'src/app/globals.css') })).css;

  // 3. Static page — cream app background, component mounted in a realistic frame.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
    <style>body{margin:0;background:#F3EFE0;padding:32px;font-family:ui-sans-serif,system-ui,sans-serif}</style></head>
    <body><div class="${frame}"><div id="root"></div></div><script>${js}</script></body></html>`;
  writeFileSync(join(work, 'page.html'), html);

  // 4. Serve on a bare localhost port (no proxy, no TLS → nothing to reset).
  const server = http.createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  // 5. Screenshot. Strip proxy vars from the browser env and use the `localhost`
  //    hostname — the combination that connects direct in this sandbox.
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) if (/^(https?|all)_proxy$/i.test(k)) delete cleanEnv[k];
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-features=HttpsUpgrades'],
    env: cleanEnv,
  });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => console.error('[shot] page error:', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[shot] console:', m.text().slice(0, 300)); });
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(wait);
    await page.screenshot({ path: out });
    console.log(`[shot] saved ${out}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error('[shot] failed:', e.message); process.exit(1); });
