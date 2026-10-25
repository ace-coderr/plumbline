import { useEffect, useState } from "react";
import { darkPalette, palette } from "../../tailwind.config";

export type Theme = "light" | "dark";

/** localStorage key for an explicit choice; index.html's inline script reads the same key. */
const KEY = "plumbline-theme";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function current(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function apply(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? darkPalette.bg : palette.bg);
}

/**
 * The active theme and a setter that remembers the choice. Until the visitor chooses, the theme
 * follows the system preference, including changes while the page is open.
 */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(current);

  useEffect(() => {
    if (stored() || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (stored()) return;
      const t: Theme = mq.matches ? "dark" : "light";
      apply(t);
      setTheme(t);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const choose = (t: Theme) => {
    apply(t);
    setTheme(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // storage unavailable: the choice lasts for this page view
    }
  };
  return [theme, choose];
}
