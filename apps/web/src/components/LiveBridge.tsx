import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { STATIC } from "../lib/api";
import { startLive, subscribeLive } from "../lib/liveStore";

/**
 * Starts the browser's chain reader (static site only) and re-runs every data query that merges live
 * data whenever the reader learns something new. Renders nothing.
 */
export function LiveBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    if (!STATIC) return;
    startLive();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeLive(() => {
      if (pending) return;
      // Coalesce a burst of updates (one per scanned chunk) into one refresh.
      pending = setTimeout(() => {
        pending = undefined;
        void qc.invalidateQueries({ predicate: (q) => q.meta?.live === true });
      }, 400);
    });
    return () => {
      unsubscribe();
      if (pending) clearTimeout(pending);
    };
  }, [qc]);
  return null;
}
