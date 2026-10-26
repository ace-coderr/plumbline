import { useSyncExternalStore } from "react";

/**
 * Private vault labels ("Our MM"). They live only in this browser's localStorage: nothing here is
 * sent to a server, written on-chain, or included in a report unless the user ticks the box. If
 * storage is unavailable or throws, labels still work for the life of the page.
 */
const KEY = "plumbline-vault-labels";
export const MAX_LABEL = 60;

type Labels = Record<string, string>;

function read(): Labels {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Labels = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string" && val) out[k] = val.slice(0, MAX_LABEL);
    return out;
  } catch {
    return {};
  }
}

let current: Labels = read();
const listeners = new Set<() => void>();

function commit(next: Labels): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage blocked or full: keep the label in memory for this page view
  }
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  // Another tab changed the labels.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    current = read();
    listeners.forEach((l) => l());
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const normalizeLabel = (s: string): string => s.trim().slice(0, MAX_LABEL);

export function useVaultLabels() {
  const labels = useSyncExternalStore(subscribe, () => current);
  return {
    labels,
    get: (vault: string): string | undefined => labels[vault.toLowerCase()],
    set: (vault: string, label: string): void => {
      const l = normalizeLabel(label);
      const next = { ...current };
      if (l) next[vault.toLowerCase()] = l;
      else delete next[vault.toLowerCase()];
      commit(next);
    },
  };
}
