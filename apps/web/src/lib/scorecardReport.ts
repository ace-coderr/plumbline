import { computeFigures, deployment, type Address, type ReportBody, type VaultScorecardData } from "@plumbline/shared";
import { STATIC } from "./api";

/** The report body for a vault's scorecard data: identity, the block it is as of, and its figures. */
export function bodyFromData(d: VaultScorecardData): ReportBody {
  const tok = (t: VaultScorecardData["base"]) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals });
  return {
    chainId: deployment.chainId,
    campaignsContract: deployment.contracts.campaigns as Address,
    vault: d.vault,
    owner: d.owner,
    pair: `${d.base.symbol}/${d.quote.symbol}`,
    base: tok(d.base),
    quote: tok(d.quote),
    asOfBlock: d.asOfBlock,
    source: STATIC ? "snapshot" : "indexer",
    figures: computeFigures(d.results, d.slashes, { base: d.base.decimals, quote: d.quote.decimals }),
  };
}

/** Save text as a file through the browser. Nothing is uploaded. */
export function downloadText(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
