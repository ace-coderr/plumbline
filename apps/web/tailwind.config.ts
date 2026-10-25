import type { Config } from "tailwindcss";

/**
 * Plumbline design tokens. The only place colours, shadows and radii are defined.
 *
 * Two themes, switched by `data-theme` on <html>: each token is a CSS variable (RGB channels, so
 * Tailwind opacity modifiers work) set per theme in src/index.css. Tailwind classes and charts read
 * the variables and flip together. `palette` holds the light values as hex for the static share
 * images and icons, which stay light.
 */
export const palette = {
  bg: "#FDF7EA", // warm cream, page background
  paper: "#FFFCF5", // card surface, a shade lighter than the page
  ink: "#121212", // every border and all body text
  violet: "#6D4AE0", // primary actions, links, active states
  highlight: "#FFD84D", // marker highlight behind key phrases, badges
  success: "#2E9E6B",
  danger: "#D94F3D",
  muted: "#6B6257", // secondary text on cream
} as const;

/** Dark-theme values, mirrored as CSS variables in src/index.css. */
export const darkPalette = {
  bg: "#1C1915", // warm charcoal, not black
  paper: "#24201A", // cards a shade above the page
  ink: "#F4ECD8", // warm off-white: body text and every border
  violet: "#8B6DF0", // lifted for contrast on charcoal
  highlight: "#FFD84D", // unchanged: the marker yellow
  success: "#3FBE85",
  danger: "#F06A57",
  muted: "#9A8F7D",
} as const;

type Token = keyof typeof palette;
const TOKENS = Object.keys(palette) as Token[];

/** Tailwind colour for a token: the theme's CSS variable, with opacity support. */
const cssColor = (t: Token) => `rgb(var(--c-${t}) / <alpha-value>)`;

/** Theme-aware colour strings for inline styles and SVG attributes (charts). */
export const themed = Object.fromEntries(TOKENS.map((t) => [t, `rgb(var(--c-${t}))`])) as Record<Token, string>;

export const shadow = {
  brut: "4px 4px 0 rgb(var(--c-shadow))",
  brutHover: "3px 3px 0 rgb(var(--c-shadow))",
} as const;

export const fonts = {
  display: ["'Bricolage Grotesque'", "ui-sans-serif", "system-ui", "sans-serif"],
  sans: ["'IBM Plex Sans'", "ui-sans-serif", "system-ui", "sans-serif"],
  mono: ["'IBM Plex Mono'", "ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
};

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: Object.fromEntries(TOKENS.map((t) => [t, cssColor(t)])),
      fontFamily: fonts,
      boxShadow: { brut: shadow.brut, "brut-hover": shadow.brutHover, none: "none" },
      borderRadius: { card: "10px" },
      letterSpacing: { display: "-0.03em", label: "0.08em" },
      fontSize: { "2xs": ["0.6875rem", { lineHeight: "1rem" }] },
    },
  },
  plugins: [],
} satisfies Config;
