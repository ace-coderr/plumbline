/**
 * Renders the raster brand assets into public/: PNG favicons from favicon.svg and the default
 * link-preview card. Run after changing the mark: `pnpm --filter @plumbline/web icons`.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSvg, renderPng } from "./og.js";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
import { palette as P } from "../tailwind.config.js";

// The favicon is generated from the tokens too, so the mark never drifts from the palette.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="1" y="1" width="30" height="30" rx="7" fill="${P.bg}" stroke="${P.ink}" stroke-width="2"/>
  <g transform="translate(4 3) scale(0.75)" stroke="${P.ink}" stroke-width="2.4" stroke-linejoin="round">
    <line x1="16" y1="1.5" x2="16" y2="12.5" stroke-width="3" stroke-linecap="round"/>
    <path d="M11.5 12.5 h9 l3.6 7 L16 30 L7.9 19.5 Z" fill="${P.violet}"/>
    <path d="M11.5 12.5 h9 l3.6 7 H7.9 Z" fill="${P.highlight}"/>
  </g>
</svg>
`;
writeFileSync(join(pub, "favicon.svg"), favicon);
writeFileSync(join(pub, "favicon-32.png"), renderPng(favicon, 32));
writeFileSync(join(pub, "apple-touch-icon.png"), renderPng(favicon, 180));
writeFileSync(join(pub, "og-default.png"), renderPng(defaultSvg()));
console.log("wrote favicon.svg, favicon-32.png, apple-touch-icon.png, og-default.png");
