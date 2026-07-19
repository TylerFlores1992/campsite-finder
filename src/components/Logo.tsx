/**
 * CampHawk brand mark: hawk in flight over layered mountains and a lake,
 * under a sunset-amber sky. Flat vector, reads at favicon size.
 *
 * NOTE: this is an AI-coded SVG concept — solid for shipping now, but plan a
 * designer / image-generation pass for final production brand art.
 */

interface MarkProps {
  size?: number;
  /** Single-color rendering for dark backgrounds, watermarks, print. */
  mono?: boolean;
  className?: string;
}

export function HawkMark({ size = 32, mono = false, className }: MarkProps) {
  if (mono) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
      >
        <rect x="1" y="1" width="62" height="62" rx="15" stroke="currentColor" strokeWidth="2" />
        <path d="M32 12c-2.5 4.5-9 8-16.5 8.5 4 2.6 9 3.4 12.6 2.4l-2.7 7.2c2.9-1.2 5.4-3.4 6.6-6 1.2 2.6 3.7 4.8 6.6 6l-2.7-7.2c3.6 1 8.6.2 12.6-2.4C41 20 34.5 16.5 32 12z" fill="currentColor" />
        <path d="M6 44l12-14 8 9 6-6 14 11v8H6v-8z" fill="currentColor" opacity="0.65" />
        <path d="M6 52h52v5H6z" fill="currentColor" opacity="0.4" />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="ch-sky" x1="32" y1="2" x2="32" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F6B26B" />
          <stop offset="0.55" stopColor="#E8873A" />
          <stop offset="1" stopColor="#D5732A" />
        </linearGradient>
      </defs>
      {/* sky */}
      <rect x="1" y="1" width="62" height="62" rx="15" fill="url(#ch-sky)" />
      {/* hawk silhouette */}
      <path
        d="M32 11c-2.5 4.5-9 8-16.5 8.5 4 2.6 9 3.4 12.6 2.4l-2.7 7.2c2.9-1.2 5.4-3.4 6.6-6 1.2 2.6 3.7 4.8 6.6 6l-2.7-7.2c3.6 1 8.6.2 12.6-2.4C41 19 34.5 15.5 32 11z"
        fill="#1F3D2E"
      />
      {/* back ridge */}
      <path d="M1 45L16 28l10 11 7-7 16 14 14-11v13H1V45z" fill="#2C5741" />
      {/* front ridge */}
      <path d="M1 50l13-12 9 10 8-8 17 13h15v10H1V50z" fill="#1F3D2E" />
      {/* lake */}
      <path d="M1 54h62v9H1z" fill="#5B8FA8" />
      {/* reflection */}
      <path d="M20 56.5h24v2H20z" fill="#8FB4C4" opacity="0.8" />
    </svg>
  );
}

interface LogoProps {
  markSize?: number;
  mono?: boolean;
  className?: string;
}

/** Full horizontal lockup: hawk badge mark + two-tone wordmark. */
export default function Logo({ markSize = 34, mono = false, className }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-mark.png"
        alt="CampHawk"
        style={{ height: markSize, width: 'auto' }}
        className="shrink-0 select-none"
        draggable={false}
      />
      <span
        className="font-serif font-semibold tracking-tight leading-none"
        style={{ fontSize: markSize * 0.6 }}
      >
        <span className={mono ? '' : 'text-green-800'}>Camp</span>
        <span className={mono ? '' : 'text-[#4a3423]'}>Hawk</span>
      </span>
    </span>
  );
}
