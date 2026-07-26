/**
 * Minimal class-name joiner for the redesign primitives.
 *
 * Deliberately not clsx/tailwind-merge: the primitives below build their classes
 * from a fixed variant map rather than merging caller overrides, so conflict
 * resolution isn't needed and a dependency would be dead weight. `className` is
 * appended last, which is enough for the layout tweaks callers actually pass
 * (width, margin, grid placement).
 */
export type ClassValue = string | false | null | undefined;

export function cx(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(" ");
}
