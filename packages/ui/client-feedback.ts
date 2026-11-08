"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Keep technical failures in developer logs, without credentials or provider URLs. */
export function logClientFailure(scope: string, failure: unknown) {
  const message = failure instanceof Error
    ? failure.message
    : typeof failure === "string" ? failure : "Request failed";
  const sanitized = message
    .replace(/AIza[\w-]+|sk-[\w-]+/g, "[redacted]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/((?:api[_ -]?key|authorization|token)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .slice(0, 1500);
  console.error(`[${scope}]`, sanitized);
}

export function useLoggedFailure(scope: string, message: string | null | undefined) {
  useEffect(() => {
    if (message) logClientFailure(scope, message);
  }, [scope, message]);
}

/** Hold the visible instruction; coalesce rapid updates to the newest pending text. */
export function useMinimumDisplay<T>(value: T, scope: string, minimumMs = 500): T {
  const key = JSON.stringify(value);
  const latest = useRef({ value, key, scope });
  latest.current = { value, key, scope };
  const [shown, setShown] = useState({ value, key, scope });
  const shownAt = useRef(0);

  useEffect(() => {
    if (!shownAt.current) shownAt.current = performance.now();
    if (shown.key === key && shown.scope === scope) return;
    const remaining = shown.scope === scope
      ? Math.max(0, minimumMs - (performance.now() - shownAt.current))
      : 0;
    const timer = window.setTimeout(() => setShown(latest.current), remaining);
    return () => window.clearTimeout(timer);
  }, [key, scope, shown.key, shown.scope, minimumMs]);

  // Start the next minimum interval after React commits the visible change.
  useLayoutEffect(() => { shownAt.current = performance.now(); }, [shown]);
  return shown.value;
}
