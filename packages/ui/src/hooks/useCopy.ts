/**
 * Copy-to-clipboard with a short "copied" acknowledgement.
 *
 * Falls back to a hidden textarea + `execCommand` because the async clipboard
 * API is unavailable on insecure origins, and CIDs are the one thing a reviewer
 * is most likely to want to paste elsewhere.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export function useCopy(resetMs = 1600): { copied: string | null; copy: (text: string) => void } {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    (text: string) => {
      const acknowledge = (): void => {
        setCopied(text);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), resetMs);
      };
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).then(acknowledge, () => setCopied(null));
        return;
      }
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "true");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        acknowledge();
      } catch {
        setCopied(null);
      } finally {
        document.body.removeChild(area);
      }
    },
    [resetMs],
  );

  return { copied, copy };
}
