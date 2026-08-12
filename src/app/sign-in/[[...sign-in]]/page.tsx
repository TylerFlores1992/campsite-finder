import Link from "next/link";
import AuthPanel from '@/components/AuthPanel';
import Logo from '@/components/Logo';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-ch-paper px-4">
      <Link href="/"><Logo markSize={40} /></Link>
      <AuthPanel mode="sign-in" />
    </div>
  );
}
