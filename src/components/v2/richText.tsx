/**
 * Provider descriptions are HTML, and we were printing the tags.
 *
 * 4,469 of the 8,013 catalog rows carry markup in `description` — mostly
 * Recreation.gov's `<h2>Overview</h2>… <h2>Recreation</h2>…` structure, plus
 * `<br>`, `<p>`, lists, and the odd `<a href>`. Rendering that as a plain string
 * printed literal tags into the About panel. (Only `description` is affected —
 * name, amenities and activities are clean in every row, so this is the one
 * place that needs it.)
 *
 * WE PARSE TO BLOCKS RATHER THAN SETTING innerHTML. Two reasons, and the second
 * is the important one:
 *   - the structure is worth keeping: those h2s are real section headings, and
 *     flattening them to one wall of text loses the shape of the description.
 *   - it is untrusted third-party HTML. dangerouslySetInnerHTML would put a
 *     provider's markup — including script-bearing attributes — inside our
 *     origin, where a session cookie lives. Text out, tags gone, no exceptions.
 *
 * Anchors keep their link TEXT and lose their href. The hrefs point off to
 * recreation.gov and nps.gov and are not the reason anyone opened this panel;
 * carrying them would mean re-deciding rel/target for markup we don't control.
 */

export type Block =
  | { kind: "h"; text: string }
  | { kind: "p"; text: string }
  | { kind: "li"; text: string };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  deg: "°",
};

/** Decode the entity set that actually shows up in this data, plus numerics. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    // &amp; last would double-decode "&amp;lt;" into "<", so named entities run
    // in one pass over the original text rather than repeatedly.
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function tidy(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Turn a provider description into renderable blocks.
 *
 * Text with no markup at all comes back as a single paragraph, so callers don't
 * need to branch on "is this HTML?" — the 3,544 clean rows go through the same
 * path as the 4,469 dirty ones.
 */
export function describeBlocks(raw: string | null | undefined): Block[] {
  if (!raw) return [];
  const src = String(raw);

  if (!/<[a-z/]/i.test(src)) {
    // Plain text, but it may still hold entities and hard line breaks.
    return src
      .split(/\n{2,}/)
      .map((t) => tidy(t))
      .filter(Boolean)
      .map((text) => ({ kind: "p" as const, text }));
  }

  // Split on the tags that START a block. Everything between two of them is one
  // block's worth of inline content, whatever inline tags it holds.
  const parts = src.split(/(<\s*\/?\s*(?:h[1-6]|p|div|br|li|ul|ol|tr)[^>]*>)/i);

  const blocks: Block[] = [];
  let kind: Block["kind"] = "p";
  let buf = "";

  const flush = () => {
    const text = tidy(buf);
    buf = "";
    if (!text) return;
    // Rec.gov often repeats a section title as the first line under its own
    // heading ("Recreation" / "Recreation"). Whichever way round it lands, the
    // second copy is noise.
    if (blocks.at(-1)?.text === text) return;
    blocks.push({ kind, text });
  };

  for (const part of parts) {
    const open = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(part);
    if (open && /^(h[1-6]|p|div|br|li|ul|ol|tr)$/i.test(open[2])) {
      flush();
      const closing = open[1] === "/";
      const tag = open[2].toLowerCase();
      // The tag that OPENS decides what the next buffer is. A closing tag just
      // ends the current one and resets to paragraph.
      kind = closing ? "p" : /^h[1-6]$/.test(tag) ? "h" : tag === "li" ? "li" : "p";
      continue;
    }
    buf += part;
  }
  flush();

  // A trailing heading with nothing under it describes a section that isn't
  // there — drop it rather than leaving a dangling title.
  while (blocks.length && blocks.at(-1)!.kind === "h") blocks.pop();

  return blocks;
}

/** Single-line version, for places with room for a sentence and no structure. */
export function describePlain(raw: string | null | undefined): string {
  return describeBlocks(raw)
    .filter((b) => b.kind !== "h")
    .map((b) => b.text)
    .join(" ");
}

/** Renders the blocks. Headings are h3s — the panel's own "About" is the h2. */
export function RichDescription({ text, className }: { text: string | null | undefined; className?: string }) {
  const blocks = describeBlocks(text);
  if (blocks.length === 0) return null;

  return (
    <div className={className}>
      {blocks.map((b, i) =>
        b.kind === "h" ? (
          <h3
            key={i}
            className="mt-4 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted first:mt-0"
          >
            {b.text}
          </h3>
        ) : b.kind === "li" ? (
          <p key={i} className="mt-1.5 flex gap-2 text-ch-body leading-relaxed text-ch-ink-2">
            <span aria-hidden="true" className="text-ch-muted">
              •
            </span>
            <span>{b.text}</span>
          </p>
        ) : (
          <p key={i} className="mt-2 text-ch-body leading-relaxed text-ch-ink-2 first:mt-0">
            {b.text}
          </p>
        ),
      )}
    </div>
  );
}
