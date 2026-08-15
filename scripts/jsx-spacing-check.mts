/**
 * Find JSX that renders two words joined together — "ReserveCaliforniacarts".
 *
 * WHY THIS IS A SCRIPT AND NOT A CODE REVIEW. The bug is invisible in the source:
 *
 *     <p>
 *       {providerLabel(source)}
 *       carts are tied to a browser session.
 *     </p>
 *
 * reads as two words on two lines and renders as one word, because JSX strips the
 * leading whitespace of every text line after the first. The fix is a space the
 * author cannot see the absence of, and the failure is silent — no error, no
 * warning, no type. So it is caught mechanically or it is caught by a user.
 *
 * The codebase already has the defence in two places (`{" isn't responding"}` in
 * WatchCard and WatchesList — a leading space INSIDE the string literal), which is
 * the tell that somebody hit this before and fixed it locally rather than globally.
 *
 * THE RULE. For each adjacent pair of rendered children, flag when the left one does
 * not end in a space, the right one does not begin with one, and EITHER the source
 * between them contains a newline, OR an HTML entity made SWC eat a space the author
 * actually typed (see HAS_ENTITY — that is the "ReserveCaliforniacarts" case, and it
 * happens on a single line).
 *
 * The newline condition is what keeps this quiet. `{count} items` on one line is
 * correct and common; `{a}{b}` on one line is a deliberate join (a currency symbol, a
 * unit suffix). A line break between two things that will touch when rendered is the
 * author saying "these are separate" to a reader while saying the opposite to the
 * compiler.
 *
 * IT WAS PORTED FROM BABEL AND THE APP IS COMPILED BY SWC. The first version reported
 * the whole codebase clean while production rendered "ReserveCaliforniacarts" on the
 * New watch screen. Agreeing with the wrong reference implementation is worse than no
 * checker at all, because it produces a confident green. Every rule here is now
 * checked against real `next build` output rather than against a spec.
 *
 *   npx tsx scripts/jsx-spacing-check.mts            # scan src/, exit 1 on a hit
 *   npx tsx scripts/jsx-spacing-check.mts src/components/v2
 */

import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/**
 * Babel's cleanJSXElementLiteralChild, ported.
 *
 * DELIBERATELY A PORT AND NOT AN APPROXIMATION. The whole value of this script is
 * that it agrees with the renderer about what a given source text produces; a
 * hand-rolled trim that is 95% right would invent findings and miss real ones, and
 * both cost more than the bug. Returns '' when the child contributes nothing at
 * all, which is how a whitespace-only line between two expressions disappears.
 */
/**
 * An HTML entity anywhere in a JSX text node makes SWC drop that node's LEADING
 * whitespace. This is the whole bug, and it is not in Babel's algorithm.
 *
 * MEASURED through real `next build` runs on 2026-08-15, not read anywhere:
 *
 *   {X()} q6none plain first / second line has a literal apostrophe   -> "ZED"," q6none…"
 *   {X()} q1lead has wouldn&apos;t on this very line                  -> "ZED","q1lead…"
 *   {X()} q3amp  / second line has &amp; ampersand                    -> "ZED","q3amp…"
 *   {X()} q4real / second line has &#39; numeric                      -> "ZED","q4real…"
 *   {X()} q5rsquo / second line has &rsquo; curly                     -> "ZED","q5rsquo…"
 *
 * So it is ANY entity, named or numeric, ANYWHERE in the node — including on a later
 * line than the space being lost. A literal apostrophe is safe. It is asymmetric:
 * `q2trail text with wouldn&apos;t entity {X()}` kept its TRAILING space, so only the
 * leading edge is affected.
 *
 * This is why the first version of this checker reported the whole app clean while
 * production rendered "ReserveCaliforniacarts" — it was ported from Babel, and the app
 * is compiled by SWC. Agreeing with the wrong reference implementation is worse than
 * having no checker, because it produces a confident green.
 */
const HAS_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/;

function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) lastNonEmptyLine = i;
  }
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, ' ');
    if (i !== 0) line = line.replace(/^ +/, '');
    if (i !== lines.length - 1) line = line.replace(/ +$/, '');
    if (line) {
      if (i !== lastNonEmptyLine) line += ' ';
      out += line;
    }
  }
  return out;
}

/** What a child contributes to the rendered string, as far as we can know it. */
interface Rendered {
  node: ts.Node;
  /** The exact text, or null when the content is opaque (a call, a variable, an element). */
  text: string | null;
  /**
   * Is this literal PROSE — words a person wrote, that another word could run into?
   *
   * This is the flag that makes the script usable. Without it the rule fires on
   * every pair of sibling elements, because essentially all JSX puts siblings on
   * their own lines: 883 hits across 79 files, of which the overwhelming majority
   * were `</a>` next to `<a>` inside a flex row with `gap-4`. Two boxes touching is
   * not a missing space — CSS decides that gap, not JSX whitespace. Only a run of
   * text can lose a space and silently become one word, so at least one side of a
   * reported pair must be prose.
   */
  isProse: boolean;
  /**
   * Is this an ELEMENT rather than a value?
   *
   * It splits the report into two tiers, because an element beside text is
   * genuinely ambiguous and a bare value beside text is not. `<Bell />` next to
   * "Find a campsite" looks like a missing space and is not one — it sits in a
   * `flex items-center gap-1.5`, so CSS owns that gap and adding `{" "}` would
   * double it. Whereas `{providerLabel(source)}` next to "carts are tied" is a
   * text run either way and can only be a bug.
   */
  isElement: boolean;
  /**
   * The author wrote a leading space and SWC ATE IT, because this text node contains
   * an HTML entity. See HAS_ENTITY. This is the one case that does NOT need a line
   * break between the two children to be a real bug — the space is right there in the
   * source, on the same line, and the compiler removes it anyway.
   */
  entityAte: boolean;
  /**
   * Is it SAFE for something to sit directly against this edge — because the edge
   * is already a space, or punctuation that is supposed to touch? Unknown is false,
   * which is the flagging direction.
   */
  startsOk: boolean;
  endsOk: boolean;
  /** Raw leading/trailing whitespace that belongs to this node (JsxText only). */
  lead: string;
  trail: string;
}

/**
 * Punctuation that correctly hugs the word before it. `…</a>` followed by
 * ". Open Settings" renders "camphawk.app. Open Settings", which is right — and
 * was three of the first 22 hits, all in hand-written prose where a link is
 * followed by a full stop.
 */
const HUGS_LEFT = /[.,;:!?%)\]}…'’"”]/;
/** …and the mirror: an opening bracket or a symbol that hugs what follows. */
const HUGS_RIGHT = /[([{$#@/\\'’"“]/;

/** Safe to place directly AFTER something: a space, or punctuation that hugs left. */
const okAsRight = (c: string | undefined) => !!c && (/[ \t]/.test(c) || HUGS_LEFT.test(c));
/** Safe to place something directly after: a space, or a symbol that hugs right. */
const okAsLeft = (c: string | undefined) => !!c && (/[ \t]/.test(c) || HUGS_RIGHT.test(c));

/**
 * The boundary CHARACTERS of one possible rendering ('' = unknown).
 *
 * Characters and not booleans, because "is it a space?" is only half the question.
 * `{hit.city}{hit.state ? `, ${hit.state}` : ""}` renders "Portland, OR" and is
 * correct: the comma HUGS the word before it. Reducing the edge to a boolean lost
 * that and reported all four city/state pairs in the codebase as bugs.
 */
interface Edge {
  first: string;
  last: string;
}

/**
 * Every NON-EMPTY rendering this expression could produce, described only by whether
 * it begins and ends with a space. null when that cannot be determined.
 *
 * Three cases, each of which produced a false positive before it was handled, and
 * all three are the SAME idiom — the author put the space inside the literal:
 *
 *   {" isn't responding"}                    bare literal
 *   {few && ' Too few this week to read.'}   literal behind a guard
 *   {site ? ` \u00b7 ${site}` : ""}               template head, empty other branch
 *
 * The empty branch is DROPPED rather than counted as "no space": it renders nothing,
 * so it cannot join anything to anything. Counting it would flag every optional
 * suffix in the codebase.
 *
 * Conservative by construction: null is treated as "no space", so an expression this
 * cannot see through is still flagged rather than skipped.
 */
function edges(e: ts.Expression): Edge[] | null {
  if (ts.isParenthesizedExpression(e)) return edges(e.expression);

  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    if (e.text === '') return [];
    return [{ first: e.text[0], last: e.text[e.text.length - 1] }];
  }

  if (ts.isTemplateExpression(e)) {
    // A template that opens with `${...}` has an unknown first character, which is
    // the conservative answer, not a missing one.
    const head = e.head.text;
    const tail = e.templateSpans[e.templateSpans.length - 1]?.literal.text ?? '';
    return [{ first: head[0] ?? '', last: tail[tail.length - 1] ?? '' }];
  }

  if (ts.isConditionalExpression(e)) {
    const a = edges(e.whenTrue);
    const b = edges(e.whenFalse);
    return a && b ? [...a, ...b] : null;
  }

  if (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    // `cond && x` renders x; the left side is the guard, not the output.
    return edges(e.right);
  }

  return null;
}

/** Does this expression produce JSX anywhere inside it? */
function containsJsx(node: ts.Node): boolean {
  let found = false;
  const walkNode = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walkNode);
  };
  walkNode(node);
  return found;
}

/**
 * An opaque child is treated as starting and ending with a NON-space. That is the
 * conservative direction on purpose: `{providerLabel(...)}` could in principle
 * return a string with a trailing space, but assuming it does would silence the
 * exact bug being hunted. A false positive costs a glance; a false negative is the
 * thing shipping.
 */
function renderedOf(child: ts.Node): Rendered | null {
  if (ts.isJsxText(child)) {
    const raw = child.getFullText();
    const babel = cleanJsxText(raw);
    if (!babel) return null; // contributes nothing — dropped, like a blank line
    // SWC drops this node's leading whitespace when it holds an entity. See HAS_ENTITY.
    const entityAte = HAS_ENTITY.test(raw) && /^[ \t]/.test(babel);
    const text = entityAte ? babel.replace(/^[ \t]+/, '') : babel;
    return {
      node: child,
      text,
      isProse: true,
      isElement: false,
      entityAte,
      startsOk: okAsRight(text[0]),
      endsOk: okAsLeft(text[text.length - 1]),
      lead: /^[ \t\r\n]*/.exec(raw)![0],
      trail: /[ \t\r\n]*$/.exec(raw)![0],
    };
  }

  if (ts.isJsxExpression(child)) {
    // `{/* a comment */}` and `{}` render nothing and are dropped.
    if (!child.expression) return null;
    const e = child.expression;
    // A string literal is the ONE case where we know the content exactly, and it
    // is the case that matters: `{" "}` and `{" isn't responding"}` are the two
    // idioms people use to put the space back. Reading them as opaque would make
    // the script flag the very fix it is asking for.
    const eg = edges(e);
    if (eg) {
      if (eg.length === 0) return null; // renders nothing at all
      return {
        node: child,
        text: null,
        isProse: true,
        isElement: false,
        entityAte: false,
        // EVERY possible rendering must be safe, or one of them joins.
        startsOk: eg.every((x) => okAsRight(x.first)),
        endsOk: eg.every((x) => okAsLeft(x.last)),
        lead: '',
        trail: '',
      };
    }
    // An expression that EVALUATES to JSX is an element for our purposes.
    // `{busy ? <Loader2 /> : <Plus />} Add` and `{email && <span className="block">…}`
    // are elements wearing an expression's clothes: the first sits in an
    // `inline-flex gap-1.5` and the second renders a block, so neither wants a
    // literal space. Classifying on the node KIND alone put all four of those in the
    // blocking tier — a gate that fails over `gap-1.5` is a gate people switch off.
    return {
      node: child,
      text: null,
      isProse: false,
      isElement: containsJsx(e),
      entityAte: false,
      startsOk: false,
      endsOk: false,
      lead: '',
      trail: '',
    };
  }

  if (
    ts.isJsxElement(child) ||
    ts.isJsxSelfClosingElement(child) ||
    ts.isJsxFragment(child)
  ) {
    // An element renders its own content; `</strong>` followed by a newline and a
    // word joins exactly like an expression does.
    return {
      node: child,
      text: null,
      isProse: false,
      isElement: true,
      entityAte: false,
      startsOk: false,
      endsOk: false,
      lead: '',
      trail: '',
    };
  }

  return null;
}

interface Finding {
  /** 'high' = a pure text run, can only be a bug. 'review' = an element is involved. */
  tier: 'high' | 'review';
  file: string;
  line: number;
  col: number;
  left: string;
  right: string;
  snippet: string;
}

function scanFile(file: string, findings: Finding[]) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const kept = node.children.map(renderedOf).filter((r): r is Rendered => r !== null);

      for (let i = 0; i < kept.length - 1; i++) {
        const a = kept[i];
        const b = kept[i + 1];

        // At least one side must be prose. See Rendered.isProse.
        if (!a.isProse && !b.isProse) continue;

        if (a.endsOk || b.startsOk) continue;

        // The separator as WRITTEN: whatever trailing whitespace belonged to the
        // left node, anything between them that was dropped, and the leading
        // whitespace of the right node.
        const between = src.slice(a.node.getEnd(), b.node.getFullStart());
        const separator = a.trail + between + b.lead;
        // The newline requirement exists to spare deliberate same-line joins like
        // {currency}{amount}. It must be WAIVED when the entity rule ate a space the
        // author actually typed — that is a bug whether or not a line break is
        // involved, and NewWatch's "ReserveCaliforniacarts" is exactly that shape:
        // the space is on the same line, and the &apos; two lines down removes it.
        if (!b.entityAte && !separator.includes('\n')) continue;

        const pos = sf.getLineAndCharacterOfPosition(b.node.getStart(sf));
        const show = (s: string | null, tail: boolean) =>
          s === null
            ? `{${a.node.getText(sf).replace(/\s+/g, ' ').slice(0, 44)}}`.replace(/^\{\{/, '{').replace(/\}\}$/, '}')
            : tail
              ? `…${s.slice(-28)}`
              : `${s.slice(0, 28)}…`;

        findings.push({
          tier: a.isElement || b.isElement ? 'review' : 'high',
          file: relative(ROOT, file),
          line: pos.line + 1,
          col: pos.character + 1,
          left: a.text === null ? a.node.getText(sf).replace(/\s+/g, ' ').slice(0, 46) : show(a.text, true),
          right: b.text === null ? b.node.getText(sf).replace(/\s+/g, ' ').slice(0, 46) : show(b.text, false),
          snippet: src
            .slice(a.node.getStart(sf), b.node.getEnd())
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
}

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
}

const targets = process.argv.slice(2);
const roots = targets.length ? targets : ['src'];
const files: string[] = [];
for (const r of roots) {
  const full = join(ROOT, r);
  if (statSync(full).isDirectory()) walk(full, files);
  else files.push(full);
}

const findings: Finding[] = [];
for (const f of files) scanFile(f, findings);

console.log(`[jsx-spacing] ${files.length} .tsx files scanned`);

const high = findings.filter((f) => f.tier === 'high');
const review = findings.filter((f) => f.tier === 'review');

const print = (f: Finding) => {
  console.log(`  ${f.file}:${f.line}:${f.col}`);
  console.log(`    joins:  ${f.left}  ><  ${f.right}`);
  console.log(`    source: ${f.snippet}`);
  console.log();
};

if (high.length) {
  console.log(`\n[jsx-spacing] ${high.length} MISSING SPACE(S) — a text run with no gap:\n`);
  high.forEach(print);
  console.log('  fix: put the space inside a literal — {" "} between them, or lead the text with it\n');
} else {
  console.log('[jsx-spacing] no missing spaces in text runs');
}

if (review.length) {
  // Not a failure. An element on one side means CSS may already own the gap, and
  // this tier exists so that ambiguity is VISIBLE rather than either silently
  // dropped or silently failing the build.
  console.log(
    `[jsx-spacing] ${review.length} to eyeball — an element is involved, so a flex gap may already cover it:\n`,
  );
  review.forEach(print);
}

// Only the unambiguous tier gates. A check that goes red over a `gap-1.5` is one
// people learn to ignore, which is the reason `lint` is kept out of `npm run verify`.
process.exit(high.length ? 1 : 0);
