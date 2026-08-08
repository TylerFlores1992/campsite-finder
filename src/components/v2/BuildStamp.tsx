'use client';

import { useEffect, useState } from 'react';
import { useIsNativeApp } from '@/lib/native/context';

/**
 * "Which build am I actually running?" — answered in the app instead of in TestFlight.
 *
 * WHY IT IS WORTH A COMPONENT. This app is a webview on camphawk.app, so **two different
 * things both call themselves "the latest version"** and they update on completely
 * different schedules:
 *   • the WEB content — every push to master, live within a minute, no store involved;
 *   • the NATIVE shell — only when someone runs a Codemagic build and ships it.
 * Almost every fix lands in the first. The handful that cannot — the launch URL, the
 * Android back button, plugin changes, push wiring — land in the second, and those are
 * exactly the ones where "am I testing the new build or the old one?" decides whether a
 * test result means anything.
 *
 * Without this the only answer was "go look in TestFlight", which is a different app,
 * and on Android "long-press the icon → App info", which reports the marketing version
 * and not the build number that actually distinguishes two uploads on the same day.
 *
 * WEB RENDERS NOTHING. There is no build to be behind on: the page is the deploy.
 */
export default function BuildStamp() {
  const isNative = useIsNativeApp();
  const [stamp, setStamp] = useState<string | null>(null);

  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    // Dynamic import: @capacitor/app is a native plugin and pulling it into the web
    // bundle would cost every browser visitor a chunk they can never use.
    void import('@capacitor/app')
      .then(({ App }) => App.getInfo())
      .then((info) => {
        // `build` is the number that actually distinguishes two uploads — `version` is
        // the marketing string and stays "1.0" across dozens of builds, which is
        // precisely how you end up testing yesterday's binary and trusting the result.
        if (!cancelled) setStamp(`${info.version} (${info.build})`);
      })
      .catch(() => {
        // A shell too old to answer is itself the answer: it predates this component.
        if (!cancelled) setStamp('unknown — update the app');
      });
    return () => { cancelled = true; };
  }, [isNative]);

  if (!isNative || !stamp) return null;

  return (
    <p className="pt-2 text-center text-ch-fine text-ch-muted">
      CampHawk app build <span className="font-semibold text-ch-ink-2">{stamp}</span>
    </p>
  );
}
