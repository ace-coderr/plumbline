/**
 * Post-build step for the static site (vite build --mode static). A static host cannot inject
 * per-request meta tags, so this writes one HTML file per report with that report's Open Graph tags
 * (dist/report/<TOKEN>.html, served at /report/<TOKEN>), and points the default page's preview at an
 * absolute image URL. Figures come from the committed snapshot; the PNGs were rendered by
 * pnpm export:static.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_DIR, SNAPSHOT_WINDOW, type DepthReport } from "@plumbline/shared";
import { reportCopy, withMeta } from "../server/meta.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const reportsDir = join(root, "public", SNAPSHOT_DIR, "reports");

// Absolute origin for preview images: explicit PUBLIC_URL, else Vercel's production domain.
const base = (
  process.env.PUBLIC_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "")
).replace(/\/$/, "");
if (!base) console.warn("prerender: no PUBLIC_URL or VERCEL_PROJECT_PRODUCTION_URL; preview image URLs will be relative");

const template = readFileSync(join(dist, "index.html"), "utf8");

writeFileSync(
  join(dist, "index.html"),
  withMeta(template, {
    title: "Plumbline · verifiable liquidity uptime",
    description: "Quote vaults, permissionless probes and bonded makers: market-making uptime you can verify on-chain.",
    image: `${base}/og-default.png`,
    url: `${base}/`,
  }),
);

const written: string[] = [];
if (existsSync(reportsDir)) {
  for (const f of readdirSync(reportsDir)) {
    const suffix = `-${SNAPSHOT_WINDOW}.json`;
    if (!f.endsWith(suffix)) continue;
    const token = f.slice(0, -suffix.length);
    const report = JSON.parse(readFileSync(join(reportsDir, f), "utf8")) as DepthReport | null;
    if (!report) continue;
    const out = join(dist, "report", `${token}.html`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      withMeta(template, {
        ...reportCopy(report, token),
        image: `${base}/og/report/${token}.png`,
        url: `${base}/report/${token}`,
      }),
    );
    written.push(`/report/${token}`);
  }
}
console.log(`prerendered ${written.join(", ") || "no reports"} (base ${base || "relative"})`);
