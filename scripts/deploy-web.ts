/**
 * Builds the static site and deploys it to Cloudflare in one go:
 *
 *   pnpm deploy:web
 *
 * It builds the shared package, builds the site in static mode with PUBLIC_URL set to the site's own address (SITE_URL in
 * packages/shared/src/links.ts, used for link-preview image addresses), then runs `wrangler deploy` in apps/web. That deploys the
 * Worker named in apps/web/wrangler.jsonc, a Worker that only serves the files in apps/web/dist. It never touches the runner Worker.
 * Needs `wrangler login` once on this computer (and CLOUDFLARE_ACCOUNT_ID in your terminal if you have several accounts).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./lib/env.js";

const run = (cmd: string, cwd: string, env: Record<string, string> = {}): void => {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { cwd, stdio: "inherit", shell: true, env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`\nstopped: "${cmd}" failed`);
    process.exit(r.status ?? 1);
  }
};

run("pnpm --filter @plumbline/shared build", ROOT);
const { SITE_URL } = (await import("../packages/shared/dist/index.js")) as { SITE_URL: string };
run("pnpm --filter @plumbline/web build:static", ROOT, { PUBLIC_URL: SITE_URL });
run("npx wrangler@4.153.0 deploy", join(ROOT, "apps/web"));
console.log(`\nDeployed. The site is at ${SITE_URL}`);
