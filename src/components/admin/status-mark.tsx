'use client';

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

/**
 * The admin dashboard's status vocabulary, in one module.
 *
 * Moved out of AdminTabs.tsx (2026-09-26) so the Subscribers list could use the SAME
 * marks rather than invent a coloured dot of its own — the owner is colour-blind, and a
 * status that differs only in hue is three grey dots to a deuteranope. AdminTabs imports
 * from here, so there is still exactly one record.
 */

export type Level = 'ok' | 'warn' | 'fail';

/**
 * The three levels, in every channel at once: a distinct icon SHAPE, a WORD, and only
 * then a colour. One record so a new status surface can't invent its own vocabulary —
 * the previous version of this file had "green dot / ochre dot / red dot" spelled out
 * inline in three different places, which is exactly how a page ends up legible only
 * to people who can separate those three hues.
 *
 * The shapes are chosen to differ at 12px in silhouette alone: a round tick, a
 * triangle, a round cross. Two triangles for warn and fail would have been prettier
 * and useless.
 */
export const LEVEL_MARK: Record<
  Level,
  { Icon: typeof CheckCircle2; word: string; box: string; text: string }
> = {
  ok: {
    Icon: CheckCircle2,
    word: 'OK',
    box: 'border-[#BFDDC9] bg-ch-green-soft',
    text: 'text-ch-green-deep',
  },
  warn: {
    Icon: AlertTriangle,
    word: 'Warning',
    box: 'border-[#E7C98C] bg-ch-ochre-soft',
    text: 'text-ch-ochre-ink',
  },
  fail: {
    Icon: XCircle,
    word: 'Failing',
    box: 'border-[#E7BFB4] bg-ch-alert-soft',
    text: 'text-ch-alert-deep',
  },
};

/**
 * The status marker used everywhere on this page.
 *
 * `showWord` only controls the VISIBLE word — it is always present for screen readers,
 * so hiding it never costs the label, just the pixels. Callers that already print the
 * word elsewhere in the row (the Alerting header says "Running"/"Stalled") pass false.
 */
export function StatusMark({
  level,
  showWord = true,
  label,
}: {
  level: Level;
  showWord?: boolean;
  /** Replaces the WORD, never the shape. For surfaces whose states are not health
   *  levels (the Subscribers list says "Cancelling", not "Warning") — the silhouette
   *  still carries the level for anyone who cannot separate the hues. */
  label?: string;
}) {
  const { Icon, text } = LEVEL_MARK[level];
  const word = label ?? LEVEL_MARK[level].word;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap font-bold ${text}`}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {showWord ? word : <span className="sr-only">{word}</span>}
    </span>
  );
}
