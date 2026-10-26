import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SECRET_NAMES, secretValues, type Env } from "../src/env.js";
import { makeLogger } from "../src/core/log.js";
import { makeRedactor, shortHash } from "../src/core/redact.js";

const hex = (n = 32) => randomBytes(n).toString("hex");
const fakeEnv = (): Env =>
  ({
    KEEPER_KEY: `0x${hex()}`,
    QUOTER_A_KEY: `0x${hex()}`,
    QUOTER_B_KEY: hex(), // without the prefix
    SPONSOR_KEY: `0x${hex()}`,
    MAKER_A_KEY: `0x${hex()}`,
    MAKER_B_KEY: `0x${hex()}`.toUpperCase().replace("0X", "0x"),
    ADMIN_TOKEN: `admin-${hex(12)}`,
  }) as unknown as Env;

function capture(env: Env) {
  const lines: string[] = [];
  const log = makeLogger(makeRedactor(secretValues(env)), (l) => lines.push(l));
  return { lines, log };
}

/** Fails if any secret value, in any spelling the runner might print it, is in `text`. */
function assertClean(env: Env, text: string): void {
  for (const name of SECRET_NAMES) {
    const v = env[name as keyof Env];
    if (typeof v !== "string") continue;
    const bare = v.replace(/^0x/i, "");
    for (const spelling of [v, v.toLowerCase(), v.toUpperCase(), bare, bare.toLowerCase(), bare.toUpperCase()]) {
      assert.ok(!text.includes(spelling), `${name} appeared in the output`);
    }
  }
  assert.ok(!/(?:0x)?[0-9a-fA-F]{64}/.test(text), "a 32-byte hex value appeared in the output");
}

describe("log redaction", () => {
  it("removes every secret, however it is interpolated", () => {
    const env = fakeEnv();
    const { lines, log } = capture(env);
    const k = env.KEEPER_KEY as string;
    log.info(`message with ${k} inside`);
    log.info("fields", { note: `key=${env.QUOTER_B_KEY}`, nested: { deep: [env.SPONSOR_KEY, `0x${(env.QUOTER_A_KEY as string).slice(2).toUpperCase()}`] } });
    log.warn("error", { err: new Error(`failed with ${env.MAKER_A_KEY}`) });
    log.error("token", { admin: env.ADMIN_TOKEN, wrapped: JSON.stringify({ k: env.MAKER_B_KEY }) });
    log.info("big", { n: 12345678901234567890n });
    assert.equal(lines.length, 5);
    for (const l of lines) assertClean(env, l);
    assert.ok(lines[4]?.includes("12345678901234567890"), "bigints still log");
  });

  it("drops fields with a secret-sounding name even when the value is innocent", () => {
    const env = fakeEnv();
    const { lines, log } = capture(env);
    log.info("x", { privateKey: "visible?", apiToken: "visible?", authorization: "Bearer visible?", seed: "visible?", ok: "kept" });
    assert.ok(!lines[0]?.includes("visible?"));
    assert.ok(lines[0]?.includes("kept"));
  });

  it("catches a key it was never told about, by its shape", () => {
    const { lines, log } = capture(fakeEnv());
    const stranger = `0x${hex()}`;
    log.info("stray", { value: stranger, bare: hex() });
    assert.ok(!lines[0]?.includes(stranger.slice(2)));
    assert.ok(!/[0-9a-f]{64}/i.test(lines[0] ?? ""));
  });

  it("holds for any random key (500 draws, every spelling)", () => {
    for (let i = 0; i < 500; i++) {
      const env = fakeEnv();
      const { lines, log } = capture(env);
      for (const n of SECRET_NAMES) {
        const v = env[n as keyof Env] as string;
        log.info(`a ${v} b`, { x: v, y: v.toLowerCase(), z: [v.toUpperCase()] });
      }
      for (const l of lines) assertClean(env, l);
    }
  });

  it("still lets a transaction hash through, shortened", () => {
    const h = `0x${hex()}`;
    const { lines, log } = capture(fakeEnv());
    log.info("sent", { tx: shortHash(h) });
    assert.ok(lines[0]?.includes(h.slice(0, 10)));
    assert.ok(!lines[0]?.includes(h));
  });

  it("never throws on an unserialisable field, and still redacts", () => {
    const env = fakeEnv();
    const { lines, log } = capture(env);
    const cyc: Record<string, unknown> = { k: env.KEEPER_KEY };
    cyc.self = cyc;
    log.info("cycle", cyc);
    assert.equal(lines.length, 1);
    assertClean(env, lines[0] as string);
  });
});

describe("source guard", () => {
  const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(decodeURIComponent(root));
  const text = (p: string) => readFileSync(p, "utf8");

  it("writes logs only through the redacting logger", () => {
    for (const f of files) {
      if (f.endsWith("log.ts")) continue;
      assert.ok(!/\bconsole\.(log|info|warn|error|debug|trace|dir)\b/.test(text(f)), `${f} writes to the console directly`);
    }
  });

  it("never serialises or prints the environment or a key", () => {
    for (const f of files) {
      const t = text(f);
      assert.ok(!/JSON\.stringify\(\s*(this\.)?env\b/.test(t), `${f} serialises env`);
      assert.ok(!/(log|logger)\.\w+\([^)]*\b(this\.)?env\.[A-Z_]*KEY/.test(t), `${f} logs a key`);
      assert.ok(!/privateKey|\.KEY\b.*\bResponse\b/.test(t.replace(/privateKeyToAccount/g, "")) || f.endsWith("env.ts"), `${f} handles a raw private key outside env.ts`);
    }
  });

  it("has no way to read the deployer's key", () => {
    for (const f of [...files, new URL("../wrangler.jsonc", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")]) {
      const t = text(decodeURIComponent(f));
      assert.ok(!/DEPLOYER_PRIVATE_KEY|DEPLOYER_KEY|process\.env/.test(t), `${f} reaches for the deployer key or process.env`);
    }
    assert.ok(!SECRET_NAMES.some((n) => /DEPLOYER/i.test(n)));
  });

  it("only returns non-secret state from the public routes", () => {
    const index = text(files.find((f) => f.endsWith("index.ts")) as string);
    assert.ok(!/env\.[A-Z_]*KEY/.test(index), "index.ts touches a key");
    // The admin token is only ever compared, never returned.
    assert.ok(!/json\([^)]*env\.ADMIN_TOKEN/.test(index));
  });
});
