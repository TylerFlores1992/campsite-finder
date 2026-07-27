/**
 * next/navigation stub for the screenshot harness.
 *
 * The harness renders components outside a Next app, so there's no
 * AppRouterContext and the real useRouter() throws "invariant expected app
 * router to be mounted" — which surfaces as a silently blank screenshot.
 * Navigation isn't exercised in a still image, so no-ops are the right shape.
 */
export function useRouter() {
  const noop = () => {};
  return { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop };
}
export function usePathname(): string {
  return "/v2";
}
export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}
export function useParams<T = Record<string, string>>(): T {
  return {} as T;
}
export function redirect(_url: string): never {
  throw new Error("redirect() called in the screenshot harness");
}
export function notFound(): never {
  throw new Error("notFound() called in the screenshot harness");
}
