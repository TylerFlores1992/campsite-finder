import AuthPanel from '@/components/AuthPanel';
import Logo from '@/components/Logo';

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-gray-50 px-4">
      <a href="/"><Logo markSize={40} /></a>
      <AuthPanel mode="sign-up" />
    </div>
  );
}
