import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelHolds, cardHolds, belongsOnCard, CARD_STATUSES } from './hold-placement';

const h = (status: string, watchId: string, id = `${status}-${watchId}`) => ({ id, status, watchId });
const onPage = (...ids: string[]) => new Set(ids);

test('offered and queued holds move to their card', () => {
  const holds = [h('offered', 'w1'), h('requested', 'w1')];
  assert.deepEqual(panelHolds(holds, onPage('w1')), [], 'both belong on the card now');
  const { offered, requested } = cardHolds(holds, 'w1');
  assert.equal(offered.length, 1);
  assert.equal(requested.length, 1);
});

test('a live cart NEVER moves off the top of the page', () => {
  // The whole reason the panel exists: ~15 minutes on a real campsite in a real cart.
  // Burying one inside a collapsed section on one card is how somebody loses the site.
  for (const status of ['carted', 'claiming', 'released']) {
    const holds = [h(status, 'w1')];
    assert.equal(
      panelHolds(holds, onPage('w1')).length,
      1,
      `${status} must stay in the page-level panel`,
    );
  }
});

test('an ORPHAN stays in the panel — that is what makes the rule safe', () => {
  // A hold outlives its watch (deleted watch), and /api/watches can fail while
  // /api/rc-holds/mine succeeds. Either way no card renders it, so the panel must.
  const holds = [h('offered', 'gone'), h('requested', 'gone')];
  assert.equal(panelHolds(holds, onPage('w1')).length, 2);
  assert.equal(panelHolds(holds, new Set<string>()).length, 2, 'no cards at all: keep everything');
});

test('an UNKNOWN status shows up rather than vanishing', () => {
  // A status added after this file was written must not fall between the two lists. Same
  // direction as byUrgency sorting an unknown status last instead of promoting it.
  const holds = [h('some_new_state', 'w1')];
  assert.equal(panelHolds(holds, onPage('w1')).length, 1);
  assert.equal(cardHolds(holds, 'w1').offered.length, 0);
  assert.equal(cardHolds(holds, 'w1').requested.length, 0);
});

test('every hold lands in EXACTLY ONE place — no gap, no double-render', () => {
  // The property the whole module exists for, stated as totality rather than trusted from
  // reading two filters: panelHolds is the complement of belongsOnCard by construction.
  const watches = ['w1', 'w2'];
  const page = onPage(...watches);
  const holds = [
    h('offered', 'w1'), h('requested', 'w1'), h('carted', 'w1'),
    h('offered', 'w2'), h('released', 'w2'), h('claiming', 'w2'),
    h('offered', 'gone'), h('mystery', 'w1'),
  ];
  const inPanel = new Set(panelHolds(holds, page).map((x) => x.id));
  const onCards = new Set(watches.flatMap((w) => {
    const { offered, requested } = cardHolds(holds, w);
    return [...offered, ...requested].map((x) => x.id);
  }));
  for (const x of holds) {
    const seen = (inPanel.has(x.id) ? 1 : 0) + (onCards.has(x.id) ? 1 : 0);
    assert.equal(seen, 1, `${x.id} appears ${seen} times; every hold must appear exactly once`);
  }
});

test('cardHolds is scoped to its own watch', () => {
  const holds = [h('offered', 'w1'), h('offered', 'w2')];
  assert.deepEqual(cardHolds(holds, 'w1').offered.map((x) => x.watchId), ['w1']);
});

test('belongsOnCard needs BOTH halves', () => {
  assert.equal(belongsOnCard(h('offered', 'w1'), onPage('w1')), true);
  assert.equal(belongsOnCard(h('offered', 'w1'), onPage('w2')), false, 'card not on the page');
  assert.equal(belongsOnCard(h('carted', 'w1'), onPage('w1')), false, 'wrong status');
});

test('the card statuses are exactly the two with nothing to do right now', () => {
  // Pinned as a SET, so widening it to include `carted` fails here rather than quietly
  // moving a fifteen-minute fuse into a collapsed section.
  assert.deepEqual([...CARD_STATUSES].sort(), ['offered', 'requested']);
});
