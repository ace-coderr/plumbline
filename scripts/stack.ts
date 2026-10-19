/**
 * Run the whole off-chain stack in one terminal: indexer, keeper, two maker bots, and the web
 * server, with prefixed logs. Ctrl+C stops everything (the bots cancel their quotes on the way out).
 *
 *   pnpm stack          production builds (run pnpm build first)
 *   pnpm stack --dev    tsx sources and the Vite dev server
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { loadEnv, ROOT } from "./lib/env.js";

loadEnv();
const dev = process.argv.includes("--dev");
const tsx = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

interface Svc {
  name: string;
  color: number;
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Start later, so services' startup reads do not hit a rate-limited RPC in one burst. */
  delayMs?: number;
}

const node = (pkg: string): Pick<Svc, "cmd" | "args"> =>
  dev ? { cmd: tsx, args: [join(ROOT, pkg, "src", "index.ts")] } : { cmd: process.execPath, args: [join(ROOT, pkg, "dist", "index.js")] };

const services: Svc[] = [
  { name: "indexer", color: 36, ...node("packages/indexer") },
  { name: "keeper", color: 33, ...node("packages/keeper"), delayMs: 3_000 },
  { name: "maker-A", color: 32, ...node("packages/maker-bot"), env: { MAKER_BOT: "A" }, delayMs: 6_000 },
  { name: "maker-B", color: 35, ...node("packages/maker-bot"), env: { MAKER_BOT: "B" }, delayMs: 12_000 },
  dev
    ? { name: "web", color: 34, cmd: join(ROOT, "apps/web/node_modules/.bin", process.platform === "win32" ? "vite.cmd" : "vite"), args: [], cwd: join(ROOT, "apps/web") }
    : { name: "web", color: 34, cmd: process.execPath, args: [join(ROOT, "apps/web/dist-server/server/index.js")] },
];

const children: ChildProcess[] = [];
function launch(s: Svc): void {
  const child = spawn(s.cmd, s.args, {
    cwd: s.cwd ?? ROOT,
    env: { ...process.env, ...s.env, FORCE_COLOR: "0" },
    shell: process.platform === "win32" && s.cmd.endsWith(".cmd"),
  });
  const tag = `\x1b[${s.color}m${s.name.padEnd(8)}\x1b[0m │ `;
  const pipe = (stream: NodeJS.ReadableStream | null) => {
    let buf = "";
    stream?.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) process.stdout.write(tag + l + "\n");
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => process.stdout.write(`${tag}exited (${String(code)})\n`));
  children.push(child);
}
for (const s of services) {
  if (s.delayMs) setTimeout(() => launch(s), s.delayMs);
  else launch(s);
}

const stop = () => {
  for (const c of children) c.kill("SIGINT");
  setTimeout(() => process.exit(0), 3_000);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
