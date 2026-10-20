/**
 * Regenerates the deployment table in README.md from the deployment record and the seed checkpoint,
 * so the README never carries hand-copied addresses.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.js";
import type { DeploymentRecord } from "./addresses.js";

const EXPLORER = "https://elysium.kinetiq.xyz/testnet-explorer";
const REPO = "https://github.com/ace-coderr/plumbline";
const link = (a: string) => `[\`${a}\`](${EXPLORER}/address/${a})`;

/**
 * Git tag marking the source a deployment was built and verified from: `deployed-<chainId>-<UTC date>`.
 * Tag the deployed commit with this name and push it, so the explorer's verified source can be checked
 * against an exact commit after `main` moves on.
 */
export const sourceTag = (d: DeploymentRecord): string => `deployed-${d.chainId}-${d.deployedAt.slice(0, 10)}`;

interface SeedCheckpoint {
  vaultA?: string;
  vaultB?: string;
  canonicalVault?: string;
  campaignId?: number;
}

export function updateReadme(d: DeploymentRecord): void {
  const path = join(ROOT, "README.md");
  if (!existsSync(path)) return;
  const seedPath = join(ROOT, "data", `seed-${d.chainId}.json`);
  const seed: SeedCheckpoint = existsSync(seedPath) ? (JSON.parse(readFileSync(seedPath, "utf8")) as SeedCheckpoint) : {};

  const rows = [
    ["PlumbQuoteFactory", d.contracts.factory],
    ["PlumbRouter", d.contracts.router],
    ["PlumbCampaigns", d.contracts.campaigns],
    ...(seed.vaultA ? [["PlumbQuote · maker A, WHYPE/PLUMBUSD (12 bps)", seed.vaultA]] : []),
    ...(seed.vaultB ? [["PlumbQuote · maker B, WHYPE/PLUMBUSD (24 bps)", seed.vaultB]] : []),
    ...(seed.canonicalVault ? [["PlumbQuote · WHYPE/USDC market (registered, unseeded)", seed.canonicalVault]] : []),
  ];
  const tokens = [
    ...Object.values(d.tokens).map((t) => [`${t.symbol} (canonical, ${t.decimals} decimals)`, t.address]),
    ...Object.values(d.demoTokens ?? {}).map((t) => [`${t.symbol} (**demo asset**, mintable, ${t.decimals} decimals)`, t.address]),
  ];
  const tag = sourceTag(d);
  const table = [
    "| contract | address |",
    "|---|---|",
    `| Verified source (git tag) | [\`${tag}\`](${REPO}/tree/${tag}) |`,
    ...rows.map(([n, a]) => `| ${n} | ${link(a ?? "")} |`),
    ...tokens.map(([n, a]) => `| ${n} | ${link(a ?? "")} |`),
  ].join("\n");

  const block = `<!-- deployment:start -->
## Deployment (Elysium testnet, chain ${d.chainId})

Deployed at block ${d.deployBlock} (${d.deployedAt}). Contracts are verified on the
[Elysium explorer](${EXPLORER}). Freshness window ${d.params.maxAge}s, withdrawal timelock ${d.params.withdrawDelay}s.${
    seed.campaignId ? ` Demo campaign: **#${seed.campaignId}**.` : ""
  }

${table}

The explorer's verified source is the tagged commit; later commits on \`main\` may differ from what is
deployed. Generated from
[\`packages/shared/src/addresses.ts\`](packages/shared/src/addresses.ts), which every package imports.
<!-- deployment:end -->`;
  const text = readFileSync(path, "utf8");
  writeFileSync(path, text.replace(/<!-- deployment:start -->[\s\S]*<!-- deployment:end -->/, block));
}
