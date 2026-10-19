/**
 * Client-side pacing for public RPC endpoints. Elysium's public RPC sustains several requests per
 * second per IP but rejects bursts with "Rate Limit Exceeded". This wraps the global fetch so that
 * requests to the given RPC hosts are spaced evenly, and a rate-limited response is retried after a
 * short backoff instead of surfacing as an error. A rejected eth_sendRawTransaction was never
 * broadcast, so retrying it is safe.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function throttleRpc(rpcUrls: string[], perSecond: number, log?: (msg: string) => void): void {
  const hosts = new Set(
    rpcUrls.flatMap((u) => {
      try {
        return [new URL(u).host];
      } catch {
        return [];
      }
    }),
  );
  const spacing = 1000 / perSecond;
  const original = globalThis.fetch;
  let nextSlot = 0;
  let limited = 0;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      // not a URL we manage
    }
    if (!hosts.has(host)) return original(input, init);

    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + spacing;
      if (wait > 0) await sleep(wait);
      const res = await original(input, init);
      const rateLimited =
        res.status === 429 || (res.ok && (await res.clone().text()).includes("Rate Limit Exceeded"));
      if (!rateLimited || attempt >= 5) return res;
      limited += 1;
      if (log && (limited === 1 || limited % 50 === 0)) log(`rpc rate-limited ${limited}x; backing off`);
      await sleep(250 * (attempt + 1));
    }
  };
}
