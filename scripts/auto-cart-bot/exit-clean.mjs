/**
 * End a one-shot run without tripping Node's Windows teardown assertion.
 *
 * WHAT HAPPENED (2026-08-07, the mini-PC). `node rc-hold-runner.mjs --once` did its work
 * and then died with:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 *
 * `process.exit()` tears the event loop down immediately. If an async handle is already
 * mid-close — undici keeps HTTP sockets alive after a fetch resolves, and Playwright's
 * browser transport is worse — libuv on Windows asserts instead of returning. A run that
 * fully succeeded ends in a crash message, and the person reading it cannot tell that
 * from the work itself failing. That is the real cost: the exit noise is indistinguishable
 * from a broken pass.
 *
 * So: set the code and let the loop DRAIN. Costs a few idle seconds while keep-alive
 * sockets time out, and exits zero.
 *
 * The unref'd fallback is for the other failure — something (a stuck socket, a browser
 * that did not close) holding the loop open forever, which for a `--once` smoke test
 * looks like a hang. It cannot itself keep the process alive, so in the normal case it
 * never fires. If it does fire we take the hard exit and its small chance of the same
 * assertion, because a hang with no output is worse than a noisy exit.
 */
export function exitWhenDrained(code = 0, hardExitAfterMs = 15_000) {
  process.exitCode = code;
  setTimeout(() => {
    console.error(
      `[exit] still running ${hardExitAfterMs / 1000}s after finishing — forcing exit ${code}. ` +
        `The work above already completed; something is holding a socket or browser open.`,
    );
    process.exit(code);
  }, hardExitAfterMs).unref();
}
