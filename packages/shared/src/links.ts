import { deployment } from "./addresses.js";

/** Where the source and the public site live. */
export const REPO_URL = "https://github.com/ace-coderr/plumbline";
export const SITE_URL = "https://plumbline-elysium.vercel.app";
const record = deployment as unknown as { legacy?: { sourceTag: string }; v2?: { sourceTag: string } };
/** Git tag of the source the current campaigns and router were built and verified from (v2 once redeployed). */
export const DEPLOYED_SOURCE_TAG = record.v2?.sourceTag ?? "deployed-99801-2026-10-19";
/** Git tag of the legacy (v1) campaigns and router, or null when there is no legacy pair. */
export const LEGACY_SOURCE_TAG: string | null = record.legacy?.sourceTag ?? null;
export const deployedSourceUrl = (): string => `${REPO_URL}/tree/${DEPLOYED_SOURCE_TAG}`;
