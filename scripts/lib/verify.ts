import { encodeAbiParameters } from "viem";
import { forge } from "./forge.js";
import type { DeploymentRecord } from "./addresses.js";

const VERIFIER_URL = process.env.ELYSIUM_VERIFIER_URL ?? "https://testnet-api.elysium.kinetiq.xyz/api/";
const RPC_URL = process.env.ELYSIUM_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz";

/** Verify one contract on the Elysium explorer (Blockscout). Failures are logged, not fatal. */
export function verifyOne(address: string, target: string, constructorArgs: `0x${string}`): boolean {
  try {
    forge([
      "verify-contract",
      address,
      target,
      "--chain",
      "99801",
      "--rpc-url",
      RPC_URL,
      "--verifier",
      "blockscout",
      "--verifier-url",
      VERIFIER_URL,
      "--constructor-args",
      constructorArgs,
      "--watch",
    ]);
    return true;
  } catch (err) {
    console.warn(`verification failed for ${target} at ${address}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Verify factory, campaigns and router. */
export function verifyCore(d: DeploymentRecord): void {
  const { factory, campaigns, router } = d.contracts;
  verifyOne(
    factory,
    "src/PlumbQuoteFactory.sol:PlumbQuoteFactory",
    encodeAbiParameters([{ type: "uint32" }, { type: "uint32" }], [d.params.maxAge, d.params.withdrawDelay]),
  );
  verifyOne(
    campaigns,
    "src/PlumbCampaigns.sol:PlumbCampaigns",
    encodeAbiParameters([{ type: "address" }, { type: "address" }], [factory, router]),
  );
  verifyOne(
    router,
    "src/PlumbRouter.sol:PlumbRouter",
    encodeAbiParameters([{ type: "address" }, { type: "address" }], [factory, campaigns]),
  );
}

/** Verify a vault deployed by the factory. */
export function verifyVault(
  vault: string,
  owner: string,
  quoter: string,
  base: string,
  quote: string,
  maxAge: number,
  withdrawDelay: number,
): boolean {
  return verifyOne(
    vault,
    "src/PlumbQuote.sol:PlumbQuote",
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint32" },
        { type: "uint32" },
      ],
      [owner as `0x${string}`, quoter as `0x${string}`, base as `0x${string}`, quote as `0x${string}`, maxAge, withdrawDelay],
    ),
  );
}
