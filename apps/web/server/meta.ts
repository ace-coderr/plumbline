/**
 * Link-preview copy and tags for report pages. No native dependencies, so the static build can use
 * it to pre-render report HTML without loading the PNG renderer.
 */
import { formatUnits } from "viem";
import type { DepthReport } from "@plumbline/shared";

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

/** Card figures from a depth report. Shared by the live server, the static exporter and prerender. */
export function cardFromReport(r: DepthReport): CardData {
  // Bid-side depth within ±50 bps of mid, from quotes the probes verified as backed.
  const band = r.depth.find((d) => d.bps === 50) ?? r.depth[0];
  const depth = band ? Number(formatUnits(BigInt(band.bidQuote), r.quote.decimals)) : 0;
  return {
    pair: `${r.token.symbol} / ${r.quote.symbol}`,
    uptime: r.verifiedUptime === null ? "—" : `${(r.verifiedUptime * 100).toFixed(2)}%`,
    spread: r.medianSpreadBps === null ? "—" : `${r.medianSpreadBps.toFixed(1)} bps`,
    // Small depths keep significant digits instead of rounding to zero.
    depth: `${depth >= 1 ? Math.round(depth).toLocaleString("en-US") : depth.toLocaleString("en-US", { maximumSignificantDigits: 2, maximumFractionDigits: 20 })} ${r.quote.symbol}`,
    probes: r.probes.toLocaleString("en-US"),
    makers: String(r.makers),
    footnote: `Every probe is an Elysium transaction. Campaigns ${r.campaigns.map((c) => `#${c}`).join(" ") || "—"}.`,
    demo: Boolean(r.quote.demo || r.token.demo),
  };
}

export interface PageMeta {
  title: string;
  description: string;
  image: string;
  url: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Title and description for a report's preview. */
export function reportCopy(r: DepthReport, _token: string): { title: string; description: string } {
  const c = cardFromReport(r);
  return {
    title: `${r.token.symbol} depth report · ${c.uptime} verified uptime`,
    description: `${c.uptime} uptime over ${r.probes.toLocaleString("en-US")} on-chain probes, median spread ${c.spread}, verified depth ${c.depth}. Every probe is an Elysium transaction.`,
  };
}

/** Replace the <!--og:start--> ... <!--og:end--> block of the built index.html. */
export function withMeta(template: string, meta: PageMeta): string {
  const tags = `<!--og:start-->
    <title>${esc(meta.title)}</title>
    <meta name="description" content="${esc(meta.description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Plumbline" />
    <meta property="og:title" content="${esc(meta.title)}" />
    <meta property="og:description" content="${esc(meta.description)}" />
    <meta property="og:url" content="${esc(meta.url)}" />
    <meta property="og:image" content="${esc(meta.image)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(meta.title)}" />
    <meta name="twitter:description" content="${esc(meta.description)}" />
    <meta name="twitter:image" content="${esc(meta.image)}" />
    <!--og:end-->`;
  return template.replace(/<!--og:start-->[\s\S]*<!--og:end-->/, tags);
}
