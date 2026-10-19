import type { Config } from "tailwindcss";

/**
 * Plumbline design tokens. The only place colours, shadows and radii are defined: Tailwind classes,
 * chart colours and the link-preview renderer all read from here.
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

export const shadow = {
  brut: `4px 4px 0 ${palette.ink}`,
  brutHover: `3px 3px 0 ${palette.ink}`,
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
      colors: palette,
      fontFamily: fonts,
      boxShadow: { brut: shadow.brut, "brut-hover": shadow.brutHover, none: "none" },
      borderRadius: { card: "10px" },
      letterSpacing: { display: "-0.03em", label: "0.08em" },
      fontSize: { "2xs": ["0.6875rem", { lineHeight: "1rem" }] },
    },
  },
  plugins: [],
} satisfies Config;
