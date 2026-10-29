import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { keccak256, parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ELYSIUM_TESTNET } from "@plumbline/shared";
import { RETURN_TO_PREFERRED_MS, Signer, classifySend, makeClients, type FallbackEvent } from "../src/chain.js";
import { nodeNames, sendOrder } from "../src/role.js";

const PRIVATE = "https://node-private.test/v1/abc123abc123";
const URLS = [PRIVATE, ELYSIUM_TESTNET.rpcUrl, "https://rpc-elysium-testnet.t.conduit.xyz"];
const TO = "0x0000000000000000000000000000000000000001";

type Step = "net" | "lost" | "rate" | "funds" | "nonce-low";

/** A fake node: what it accepts, what it has seen, and a queue of ways the next submission goes wrong. */
class Node {
  submitted: Hex[] = [];
  accepted = new Set<string>();
  steps: Step[] = [];
  counts = 0;
  nonce: number;
  nonceReads = 0;
  constructor(nonce = 5) {
    this.nonce = nonce;
  }
}

function world(nodes: Node[]) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const i = URLS.findIndex((u) => new URL(u).href === new URL(String(url)).href);
    const node = nodes[i];
    if (!node) throw new Error(`unknown node ${String(url)}`);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    const err = (message: string) => Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message } });
    switch (body.method) {
      case "eth_getTransactionCount":
        node.nonceReads += 1;
        return ok(`0x${node.nonce.toString(16)}`);
      case "eth_gasPrice":
        return ok("0x5f5e100");
      case "eth_getTransactionByHash": {
        const h = String(body.params[0]);
        if (!node.accepted.has(h)) return ok(null);
        return ok({ hash: h, nonce: "0x0", blockHash: null, blockNumber: null, transactionIndex: null, from: TO, to: TO, value: "0x0", gas: "0x5208", gasPrice: "0x1", input: "0x", type: "0x2", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x0", chainId: "0x185d9", v: "0x0", r: "0x1", s: "0x1", yParity: "0x0", accessList: [] });
      }
      case "eth_sendRawTransaction": {
        const raw = String(body.params[0]) as Hex;
        node.submitted.push(raw);
        const hash = keccak256(raw);
        const step = node.steps.shift();
        if (step === "net") throw new TypeError("fetch failed: Network connection lost");
        if (step === "rate") return new Response("Rate Limit Exceeded", { status: 429 });
        if (step === "funds") return err("insufficient funds for gas * price + value");
        if (step === "nonce-low") return err("nonce too low");
        if (step === "lost") {
          node.accepted.add(hash); // the node took it, and the answer never arrives
          throw new TypeError("fetch failed: Network connection lost");
        }
        if (node.accepted.has(hash)) return err("already known");
        node.accepted.add(hash);
        node.nonce += 1;
        return ok(hash);
      }
      default:
        return err("not mocked");
    }
  }) as typeof fetch;
  return () => void (globalThis.fetch = real);
}

describe("how a failed send is classified", () => {
  it("separates what the node did from what the transaction was", () => {
    assert.equal(classifySend(new Error("already known")), "known");
    assert.equal(classifySend(new Error("known transaction: 0xabc")), "known");
    assert.equal(classifySend(new Error("nonce too low: next nonce 7, tx nonce 6")), "nonce-low");
    assert.equal(classifySend(new Error("insufficient funds for gas")), "rejected");
    assert.equal(classifySend(new Error("execution reverted")), "rejected");
    assert.equal(classifySend(new Error("Rate Limit Exceeded")), "rate-limit");
    assert.equal(classifySend(new Error("HTTP 429")), "rate-limit");
    assert.equal(classifySend(new Error("Network connection lost")), "transient");
    assert.equal(classifySend(new Error("the request timed out")), "transient");
    assert.equal(classifySend(new Error("HTTP request failed. Status: 503")), "transient");
  });
});

describe("the signer: nonce and double-send safety", () => {
  let nodes: Node[];
  let restore: () => void;
  let now = 1_000_000;
  const realNow = Date.now;
  const events: FallbackEvent[] = [];
  const key = generatePrivateKey();
  const make = (opts: { hook?: (e: FallbackEvent) => void } = {}) => new Signer(privateKeyToAccount(key), makeClients(PRIVATE), { names: ["private", "elysium", "conduit"], onFallback: opts.hook ?? ((e) => void events.push(e)) });
  const send = (s: Signer) => s.send(TO, "0x", 21_000n);
  const nonceOf = (raw: Hex) => parseTransaction(raw).nonce;

  beforeEach(() => {
    nodes = [new Node(5), new Node(5), new Node(5)];
    restore = world(nodes);
    events.length = 0;
    now = 1_000_000;
    Date.now = () => now;
  });
  afterEach(() => {
    restore();
    Date.now = realNow;
  });

  it("a clean send is one submission and the next send uses the next nonce without reading it again", async () => {
    const s = make();
    const h1 = await send(s);
    const h2 = await send(s);
    assert.notEqual(h1, h2);
    assert.deepEqual(nodes[0]!.submitted.map(nonceOf), [5, 6]);
    assert.equal(nodes[0]!.nonceReads, 1);
    assert.equal(events.length, 0);
  });

  it("a send that fails once is tried again on the same node with the very same signed bytes", async () => {
    nodes[0]!.steps = ["net"];
    const s = make();
    const hash = await send(s);
    assert.equal(nodes[0]!.submitted.length, 2);
    assert.equal(nodes[0]!.submitted[0], nodes[0]!.submitted[1], "the same bytes, not a new signature");
    assert.equal(hash, keccak256(nodes[0]!.submitted[0]!));
    assert.equal(nodes[0]!.accepted.size, 1);
    assert.equal(events.length, 0, "no fall back for a single failure");
    assert.equal(s.fellBack, false);
  });

  it("a lost response is one transaction, not two: the retry meets 'already known' and that is success", async () => {
    nodes[0]!.steps = ["lost"];
    const s = make();
    const hash = await send(s);
    assert.equal(nodes[0]!.accepted.size, 1, "exactly one transaction exists");
    assert.equal(nodes[0]!.submitted.length, 2);
    assert.equal(nodes[0]!.submitted[0], nodes[0]!.submitted[1]);
    assert.equal(hash, keccak256(nodes[0]!.submitted[0]!));
    assert.equal(events.length, 0);
    // The next send is the next nonce, with no new read.
    await send(s);
    assert.deepEqual(nodes[0]!.submitted.map(nonceOf), [5, 5, 6]);
    assert.equal(nodes[0]!.nonceReads, 1);
  });

  it("when both tries fail the nonce is read again from the next node, and at most one of two transactions can ever land", async () => {
    nodes[0]!.steps = ["lost", "net"]; // the node took the first one, and then went away
    const s = make();
    await assert.rejects(() => send(s));
    assert.equal(events.length, 1);
    assert.deepEqual({ from: events[0]!.from, to: events[0]!.to, failure: events[0]!.failure }, { from: 0, to: 1, failure: "transient" });
    assert.equal(s.fellBack, true);
    // The next send goes to the second node, which never saw the first and reports the same pending nonce:
    await send(s);
    assert.equal(nodes[1]!.nonceReads, 1, "the nonce was read again, from the node now in use");
    assert.equal(nodes[1]!.submitted.length, 1);
    assert.equal(nonceOf(nodes[1]!.submitted[0]!), nonceOf(nodes[0]!.submitted[0]!), "the same nonce, so only one of them can ever be mined");
  });

  it("goes back to the preferred node after 30 seconds, and keeps its own nonce", async () => {
    nodes[0]!.steps = ["net", "net"];
    const s = make();
    await assert.rejects(() => send(s));
    await send(s); // node 1
    now += RETURN_TO_PREFERRED_MS - 1_000;
    await send(s);
    assert.equal(nodes[1]!.submitted.length, 2, "still on the fallback node just before the wait is over");
    now += 2_000;
    await send(s);
    assert.equal(nodes[0]!.submitted.length, 3, "back on the preferred node");
    assert.equal(s.fellBack, false);
    assert.equal(nodes[1]!.nonceReads, 1, "the return did not read the nonce again");
  });

  it("a node that is still failing after the return falls back again, and says so each time", async () => {
    nodes[0]!.steps = ["net", "net", "net", "net"];
    const s = make();
    await assert.rejects(() => send(s));
    now += RETURN_TO_PREFERRED_MS + 1;
    await assert.rejects(() => send(s));
    assert.equal(events.length, 2);
  });

  it("a rate limit moves on at once, without asking the same node again", async () => {
    nodes[0]!.steps = ["rate"];
    const s = make();
    await assert.rejects(() => send(s));
    assert.equal(nodes[0]!.submitted.length, 1);
    assert.equal(events[0]!.failure, "rate-limit");
    assert.equal(s.fellBack, true);
  });

  it("a transaction the node refuses is not retried and does not move the signer", async () => {
    nodes[0]!.steps = ["funds"];
    const s = make();
    await assert.rejects(() => send(s), /insufficient funds/);
    assert.equal(nodes[0]!.submitted.length, 1);
    assert.equal(events.length, 0);
    assert.equal(s.fellBack, false);
    await send(s);
    assert.equal(nodes[0]!.nonceReads, 2, "the nonce is read again after a refusal");
  });

  it("'nonce too low' is success only if the node can show our transaction", async () => {
    const known = make();
    nodes[0]!.steps = ["nonce-low"];
    // Make the node report our transaction as already in: its hash is the keccak of the bytes that will be sent.
    const original = nodes[0]!.steps;
    void original;
    const mark = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === "eth_sendRawTransaction") nodes[0]!.accepted.add(keccak256(String(body.params[0]) as Hex));
      return mark(url, init);
    }) as typeof fetch;
    const hash = await send(known);
    assert.equal(hash, keccak256(nodes[0]!.submitted[0]!));
    assert.equal(nodes[0]!.submitted.length, 1, "no second submission");
    globalThis.fetch = mark;

    nodes = [new Node(5), new Node(5), new Node(5)];
    restore();
    restore = world(nodes);
    nodes[0]!.steps = ["nonce-low"];
    const unknown = make();
    await assert.rejects(() => send(unknown), /nonce too low/);
    assert.equal(nodes[0]!.submitted.length, 1, "not retried");
    assert.equal(events.length, 0, "a nonce problem is not a node problem");
    await send(unknown);
    assert.equal(nodes[0]!.nonceReads, 2, "the nonce is read again");
  });

  it("a hook that throws cannot stop the send from failing cleanly", async () => {
    nodes[0]!.steps = ["net", "net"];
    const s = make({ hook: () => { throw new Error("hook broke"); } });
    await assert.rejects(() => send(s), /Network connection lost/);
    assert.equal(s.fellBack, true);
  });

  it("with only one node nothing falls back and the error is returned", async () => {
    nodes[0]!.steps = ["net", "net"];
    const s = new Signer(privateKeyToAccount(key), makeClients(PRIVATE).slice(0, 1), { onFallback: (e) => void events.push(e) });
    await assert.rejects(() => send(s));
    assert.equal(events.length, 0);
    assert.equal(s.fellBack, false);
  });
});

describe("the node order", () => {
  it("with a private node both makers go private, then Elysium, then Conduit", () => {
    const c = makeClients(PRIVATE);
    assert.deepEqual(sendOrder(c, 0), [c[0], c[1], c[2]]);
    assert.deepEqual(sendOrder(c, 1), [c[0], c[1], c[2]]);
    const names = nodeNames(c);
    assert.deepEqual(sendOrder(c, 1).map((x) => names.get(x)), ["private node", "public node (Elysium)", "public node (Conduit)"]);
  });

  it("without one the two makers still start on different public nodes", () => {
    const c = makeClients();
    assert.deepEqual(sendOrder(c, 0), [c[0], c[1]]);
    assert.deepEqual(sendOrder(c, 1), [c[1], c[0]]);
    assert.deepEqual([...nodeNames(c).values()], ["public node (Elysium)", "public node (Conduit)"]);
  });
});
