import Link from "next/link";
import AuthPanel from '@/components/AuthPanel';
import Logo from '@/components/Logo';

export default function SignUpPage() {
  return (
    <div
      // SAFE-AREA INSET. This screen is outside the (app) route group, so V2Nav —
      // where every other screen's status-bar handling lives — never runs. Android 16
      // IGNORES Capacitor's `overlaysWebView: false`, so the webview draws under the
      // status bar. This column is vertically CENTRED, so the failure here is the other
      // one: content taller than the viewport overflows equally at both ends and the top
      // of it goes under the bar, unreachable. Reserving the band keeps the centring
      // region below it. Resolves to 0px on the web, so nothing outside the app moves.
      // Rule and full mechanism: src/lib/safe-area-top.test.mts.
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      className="min-h-screen flex flex-col items-center justify-center gap-6 bg-ch-paper px-4"
    >
      <Link href="/"><Logo markSize={40} /></Link>
      <AuthPanel mode="sign-up" />
    </div>
  );
}
