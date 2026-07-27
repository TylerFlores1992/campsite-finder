import Link from 'next/link';
import Logo from '@/components/Logo';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-[#F3EFE0] px-4 text-center">
      <Logo markSize={40} />
      <div>
        <p className="font-ch-display text-5xl font-extrabold text-ch-green-deep">404</p>
        <p className="mt-2 text-ch-ink-2 max-w-sm">
          This trail doesn&apos;t lead anywhere. The page you&apos;re looking for
          may have moved or never existed.
        </p>
      </div>
      <Link
        href="/"
        className="px-6 py-3 rounded-2xl bg-ch-green hover:bg-ch-green-deep text-white font-ch-display font-semibold shadow-md transition-colors"
      >
        Back to home
      </Link>
    </div>
  );
}
