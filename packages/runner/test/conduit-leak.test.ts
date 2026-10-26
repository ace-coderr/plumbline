import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { HttpRequestError, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import worker from "../src/index.js";
import { Supervisor } from "../src/supervisor.js";
import { Signer, makeClients } from "../src/chain.js";
import { redactorFor, secretValues, type Env } from "../src/env.js";
import { errText, makeLogger, safeJson, setRedactor } from "../src/core/log.js";

/** Three shapes of node URL: the key in the path, in a path segment with a slash after it, and in the query. */
const hex = (n: number) => randomBytes(n).toString("hex");
const shapes = () => {
  const key = hex(20);
  return [
    { key, url: `https://rpc.conduit.xyz/v1/${key}` },
    { key, url: `https://rpc.conduit.xyz/${key}/` },
    { key, url: `https://node.example.com/elysium/testnet?apikey=${key}&x=1` },
  ];
};
const envFor = (url: string): Env => ({ CONDUIT_RPC_URL: url, KEEPER_KEY: `0x${hex(32)}`, ADMIN_TOKEN: hex(32) }) as unknown as Env;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setRedactor((s) => s);
});

/** Every way a string might carry the key: raw, upper-case, URL-encoded. */
function assertNoKey(text: string, key: string, where: string): void {
  for (const form of [key, key.toUpperCase(), encodeURIComponent(key)]) assert.ok(!text.includes(form), `the API key appeared in ${where}`);
}

describe("a private node URL never leaks", () => {
  for (const [i, s] of shapes().entries()) {
    const env = envFor(s.url);

    it(`shape ${i}: a thrown RPC error, as logged, stored and returned`, async () => {
      setRedactor(redactorFor(env));
      const err = new HttpRequestError({ url: s.url, body: { method: "eth_sendRawTransaction", params: ["0x02f8"] }, details: `Rate limit exceeded for ${s.url}` });
      assert.ok(err.message.includes(s.key), "the test error really carries the key");
      const lines: string[] = [];
      const log = makeLogger(redactorFor(env), (l) => lines.push(l));
      log.warn("send failed", { err, text: errText(err), reason: `${err.message}\n${err.stack ?? ""}` });
      assertNoKey(lines.join("\n"), s.key, "a log line");
      assertNoKey(errText(err), s.key, "errText");
      const res = safeJson({ halt: { reason: `could not read: ${err.message}` }, deep: [{ x: s.url }] });
      assertNoKey(await res.text(), s.key, "a JSON response");
    });

    it(`shape ${i}: the real transport, failing and rate-limited`, async () => {
      setRedactor(redactorFor(env));
      const [client] = makeClients(s.url) as [PublicClient];
      for (const failure of ["reject", "429"] as const) {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          if (failure === "reject") throw new Error(`connect ECONNREFUSED ${String(input)}`);
          return new Response(`Rate Limit Exceeded for ${String(input)}`, { status: 429 });
        }) as typeof fetch;
        let caught: unknown;
        try {
          await client.getBlockNumber();
        } catch (e) {
          caught = e;
        }
        assert.ok(caught, "the call fails");
        const lines: string[] = [];
        makeLogger(redactorFor(env), (l) => lines.push(l)).error("rpc", { err: caught, text: errText(caught) });
        assertNoKey(lines.join("\n"), s.key, `a log of a ${failure} failure`);
        assertNoKey(errText(caught), s.key, `errText of a ${failure} failure`);
      }
    });

    it(`shape ${i}: a failed send through the Signer`, async () => {
      setRedactor(redactorFor(env));
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "eth_getTransactionCount") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
        if (body.method === "eth_gasPrice") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x5f5e100" });
        return new Response(`Rate Limit Exceeded ${String(input)}`, { status: 429 });
      }) as typeof fetch;
      const signer = new Signer(privateKeyToAccount(`0x${hex(32)}`), makeClients(s.url).slice(0, 1));
      let caught: unknown;
      try {
        await signer.send("0x0000000000000000000000000000000000000001", "0x", 21_000n);
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "the send is refused");
      assertNoKey(errText(caught), s.key, "the Signer error");
    });

    it(`shape ${i}: the supervisor report and the public /health`, async () => {
      setRedactor(redactorFor(env));
      // State written by an older version that did not scrub: the report must still not return it.
      const m = new Map<string, unknown>([
        ["halt", { kind: "rpc", reason: `could not read: ${s.url}`, day: "d", windowStart: 1, at: 1 }],
        ["campaignNote", `note ${s.url}`],
      ]);
      const state = {
        storage: {
          get: async (k: string) => m.get(k),
          put: async (k: string, v: unknown) => void m.set(k, v),
          delete: async () => true,
          setAlarm: async () => undefined,
          getAlarm: async () => null,
          deleteAlarm: async () => undefined,
        },
      };
      const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ running: false, leaked: s.url }) }) };
      const full = { ...env, SUPERVISOR: ns, ROLE: ns } as unknown as Env;
      const report = await new Supervisor(state as never, full).fetch(new Request("https://supervisor/state"));
      assertNoKey(await report.text(), s.key, "the supervisor report");
      const health = await worker.fetch(new Request("https://runner/health"), full);
      assertNoKey(await health.text(), s.key, "/health");
      const bad = await worker.fetch(new Request("https://runner/kill", { method: "POST", headers: { authorization: `Bearer ${s.url}` } }), full);
      assertNoKey(await bad.text(), s.key, "a rejected admin call");
    });

    it(`shape ${i}: the redactor knows every form of the secret`, () => {
      const needles = secretValues(env);
      assert.ok(needles.includes(s.url));
      assert.ok(needles.some((n) => n.includes(s.key) && n !== s.url), "the path or query alone is a needle");
      const r = redactorFor(env);
      const u = new URL(s.url);
      for (const form of [s.url, u.pathname, encodeURIComponent(s.url), s.key, `prefix-${s.key}-suffix`, u.search]) {
        if (form.length >= 8) assertNoKey(r(`x ${form} y`), s.key, `redacting ${form.slice(0, 18)}`);
      }
    });
  }
});

describe("source guard for the node URL", () => {
  const dir = decodeURIComponent(new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  const text = (f: string) => readFileSync(dir + f, "utf8");

  it("is read only to build the clients, never logged or returned", () => {
    for (const f of files) {
      const t = text(f);
      if (!t.includes("CONDUIT_RPC_URL")) continue;
      assert.ok(["env.ts", "role.ts", "supervisor.ts"].includes(f.replace(/\\/g, "/")), `${f} reads CONDUIT_RPC_URL`);
      assert.ok(!/(log|logger)\.\w+\([^)]*CONDUIT_RPC_URL/.test(t), `${f} logs it`);
      assert.ok(!/(json|Response|safeJson)\([^)]*CONDUIT_RPC_URL/.test(t), `${f} returns it`);
      for (const line of t.split("\n")) {
        if (line.includes("env.CONDUIT_RPC_URL")) assert.ok(/makeClients\(this\.env\.CONDUIT_RPC_URL\)/.test(line), `${f}: ${line.trim()}`);
      }
    }
  });

  it("never builds an error message from a URL", () => {
    for (const f of files) assert.ok(!/new Error\(`[^`]*\$\{[^}]*(rpcUrl|privateUrl|url)\b/.test(text(f)), `${f} puts a URL in an error message`);
  });
});
