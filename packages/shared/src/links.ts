/** Where the source and the public site live. */
export const REPO_URL = "https://github.com/ace-coderr/plumbline";
export const SITE_URL = "https://plumbline-elysium.vercel.app";
/** Git tag of the source the deployed contracts were built and verified from. */
export const DEPLOYED_SOURCE_TAG = "deployed-99801-2026-10-19";
export const deployedSourceUrl = (): string => `${REPO_URL}/tree/${DEPLOYED_SOURCE_TAG}`;
