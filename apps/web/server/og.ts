import { Resvg } from "@resvg/resvg-js";
import { palette as P } from "../tailwind.config.js";

/** Data shown on a report's link-preview card. */
export interface CardData {
  pair: string;
  uptime: string;
  spread: string;
  depth: string;
  probes: string;
  makers: string;
  footnote: string;
  demo: boolean;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MONO = "IBM Plex Mono, JetBrains Mono, Consolas, DejaVu Sans Mono, Menlo, monospace";
const DISPLAY = "Bricolage Grotesque, Segoe UI Black, Arial Black, Helvetica, sans-serif";
const SANS = "IBM Plex Sans, Segoe UI, Helvetica, Arial, sans-serif";

/** A box with a hard 8px offset shadow, the card's one structural motif. */
function box(x: number, y: number, w: number, h: number, fill: string, r = 16): string {
  return `<rect x="${x + 8}" y="${y + 8}" width="${w}" height="${h}" rx="${r}" fill="${P.ink}"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${P.ink}" stroke-width="4"/>`;
}

function mark(x: number, y: number, s: number): string {
  return `<g transform="translate(${x} ${y}) scale(${s / 32})" stroke="${P.ink}" stroke-width="2" stroke-linejoin="round">
    <line x1="16" y1="1.5" x2="16" y2="12.5" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M11.5 12.5 h9 l3.6 7 L16 30 L7.9 19.5 Z" fill="${P.violet}"/>
    <path d="M11.5 12.5 h9 l3.6 7 H7.9 Z" fill="${P.highlight}"/>
  </g>`;
}

function stat(x: number, y: number, label: string, value: string): string {
  // Each column is 260px wide; long values (e.g. "0.073 PLUMBUSD") step down so they never collide.
  const size = value.length > 10 ? 28 : 40;
  return `<text x="${x}" y="${y}" font-family="${MONO}" font-size="18" font-weight="700" letter-spacing="2" fill="${P.muted}">${esc(label)}</text>
  <text x="${x}" y="${y + 50}" font-family="${MONO}" font-size="${size}" font-weight="700" fill="${P.ink}">${esc(value)}</text>`;
}

/** Report card: the shareable artifact's preview image. */
export function reportSvg(d: CardData): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${P.bg}"/>
  ${box(40, 36, 1112, 550, P.paper, 20)}
  ${mark(80, 70, 44)}
  <text x="136" y="104" font-family="${DISPLAY}" font-size="34" font-weight="800" letter-spacing="-1" fill="${P.ink}">plumbline</text>
  <text x="1112" y="102" text-anchor="end" font-family="${MONO}" font-size="18" font-weight="700" fill="${P.violet}">VERIFIED DEPTH REPORT</text>
  <line x1="80" y1="134" x2="1112" y2="134" stroke="${P.ink}" stroke-width="3"/>
  <text x="80" y="214" font-family="${MONO}" font-size="60" font-weight="700" fill="${P.ink}">${esc(d.pair)}</text>
  ${
    d.demo
      ? `<rect x="80" y="236" width="176" height="36" rx="8" fill="${P.highlight}" stroke="${P.ink}" stroke-width="3"/>
  <text x="168" y="261" text-anchor="middle" font-family="${MONO}" font-size="18" font-weight="700" fill="${P.ink}">DEMO ASSET</text>`
      : ""
  }
  <text x="80" y="318" font-family="${MONO}" font-size="20" font-weight="700" letter-spacing="2" fill="${P.muted}">VERIFIED UPTIME</text>
  ${box(80, 334, 470, 150, P.highlight, 14)}
  <text x="315" y="436" text-anchor="middle" font-family="${MONO}" font-size="92" font-weight="700" fill="${P.ink}">${esc(d.uptime)}</text>
  ${stat(620, 330, "MEDIAN SPREAD", d.spread)}
  ${stat(880, 330, "PROBES", d.probes)}
  ${stat(620, 420, "DEPTH ±50 BPS", d.depth)}
  ${stat(880, 420, "MAKERS", d.makers)}
  <text x="80" y="548" font-family="${SANS}" font-size="20" fill="${P.ink}">${esc(d.footnote)}</text>
</svg>`;
}

/** Generic card for every other page. */
export function defaultSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${P.bg}"/>
  ${box(40, 36, 1112, 550, P.paper, 20)}
  ${mark(96, 196, 150)}
  <text x="290" y="318" font-family="${DISPLAY}" font-size="120" font-weight="800" letter-spacing="-4" fill="${P.ink}">plumbline</text>
  <rect x="290" y="352" width="612" height="52" rx="6" fill="${P.highlight}"/>
  <text x="302" y="390" font-family="${SANS}" font-size="34" font-weight="600" fill="${P.ink}">Liquidity you can check, not trust.</text>
  <text x="96" y="540" font-family="${MONO}" font-size="20" font-weight="700" fill="${P.muted}">QUOTE VAULTS · PERMISSIONLESS PROBES · BONDED MAKERS · ELYSIUM</text>
</svg>`;
}

export function renderPng(svg: string, width?: number): Buffer {
  const r = new Resvg(svg, {
    fitTo: width ? { mode: "width", value: width } : { mode: "original" },
    font: { loadSystemFonts: true, defaultFontFamily: "Consolas" },
    background: P.bg,
  });
  return r.render().asPng();
}
