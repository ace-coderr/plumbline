/**
 * Render plumbline-motion.html to H.264 MP4, one frame at a time, using only Chrome.
 *
 *   npm install && npm run render          both aspect ratios
 *   node render.mjs 16x9                   one of them
 *   node render.mjs --stills 2.4 13.9      PNG stills at those times, for review
 *
 * Headless Chrome loads the composition, seeks its paused GSAP timeline to each frame time
 * (frame / FPS) and screenshots the stage. Each PNG goes to Chrome's own H.264 encoder (WebCodecs
 * VideoEncoder) with an exact timestamp, and mp4.mjs writes the encoded frames into an MP4 (4:2:0,
 * index at the front). Every frame is rendered from the timeline, never captured in real time, so
 * none can be dropped and every run produces the same frames. No ffmpeg needed. Fonts and GSAP load
 * from their CDNs, so the render needs network access.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { writeMp4 } from "./mp4.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = pathToFileURL(join(HERE, "plumbline-motion.html")).href;
const OUT = join(HERE, "out");
const FPS = 30;
const KEY_EVERY = 60; // a keyframe every 2 s

// Bitrates keep each file under 16 MB, which messaging apps accept without heavy recompression.
const VARIANTS = {
  "1x1": { width: 1080, height: 1080, bitrate: 4_500_000, file: "plumbline-1x1.mp4" },
  "16x9": { width: 1920, height: 1080, bitrate: 4_800_000, file: "plumbline-16x9.mp4" },
};

async function launch() {
  // System Chrome carries the H.264 encoder; Playwright's Chromium is a fallback for stills.
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch {
    return await chromium.launch();
  }
}

async function open(browser, name) {
  const v = VARIANTS[name];
  const page = await browser.newPage({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1 });
  await page.goto(`${SOURCE}?ar=${name}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
  return { page, stage: page.locator("#stage"), v };
}

async function stills(browser, name, times) {
  const { page, stage } = await open(browser, name);
  mkdirSync(join(OUT, "stills"), { recursive: true });
  for (const t of times) {
    await page.evaluate((s) => window.__seek(s), t);
    await stage.screenshot({ path: join(OUT, "stills", `${name}-${t.toFixed(2)}.png`), animations: "disabled" });
  }
  await page.close();
  console.log(`${name}: ${times.length} stills in ${join(OUT, "stills")}`);
}

/** An H.264 encoder running in its own page (WebCodecs needs a secure context; file:// is one). */
async function openEncoder(browser, v) {
  const page = await browser.newPage();
  await page.goto(SOURCE);
  const codec = await page.evaluate(
    async ({ width, height, bitrate, fps }) => {
      if (!window.isSecureContext || !("VideoEncoder" in window)) throw new Error("WebCodecs unavailable");
      // High, then Main, then Baseline, all level 4.0: whichever this Chrome encodes in software.
      let config = null;
      for (const codec of ["avc1.640028", "avc1.4D4028", "avc1.42E028"]) {
        const c = {
          codec,
          width,
          height,
          bitrate,
          bitrateMode: "variable",
          framerate: fps,
          latencyMode: "quality",
          hardwareAcceleration: "prefer-software",
          avc: { format: "avc" },
        };
        if ((await VideoEncoder.isConfigSupported(c)).supported) {
          config = c;
          break;
        }
      }
      if (!config) throw new Error("no H.264 encoder in this browser");
      const st = { chunks: [], avcC: null, error: null };
      window.__st = st;
      const enc = new VideoEncoder({
        output: (chunk, meta) => {
          if (meta && meta.decoderConfig && meta.decoderConfig.description && !st.avcC) {
            st.avcC = new Uint8Array(meta.decoderConfig.description);
          }
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          st.chunks.push({ data, ts: chunk.timestamp, key: chunk.type === "key" });
        },
        error: (e) => (st.error = String(e)),
      });
      enc.configure(config);
      const b64 = (u) => {
        let s = "";
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        return btoa(s);
      };
      window.__encode = async (png64, i, keyEvery) => {
        if (st.error) throw new Error(st.error);
        const bin = atob(png64);
        const bytes = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const frame = new VideoFrame(bmp, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        enc.encode(frame, { keyFrame: i % keyEvery === 0 });
        frame.close();
        bmp.close();
        while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
      };
      window.__finish = async () => {
        await enc.flush();
        enc.close();
        if (st.error) throw new Error(st.error);
        return { count: st.chunks.length, avcC: b64(st.avcC) };
      };
      window.__take = (from, to) =>
        st.chunks.slice(from, to).map((c) => ({ data: b64(c.data), ts: c.ts, key: c.key }));
      return config.codec;
    },
    { width: v.width, height: v.height, bitrate: v.bitrate, fps: FPS },
  );
  return { page, codec };
}

async function render(browser, name) {
  const { page, stage, v } = await open(browser, name);
  const enc = await openEncoder(browser, v);
  const duration = await page.evaluate(() => window.__duration);
  const frames = Math.round(duration * FPS);
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.__seek(t), i / FPS);
    const png = await stage.screenshot({ type: "png", animations: "disabled" });
    await enc.page.evaluate(([b, n, k]) => window.__encode(b, n, k), [png.toString("base64"), i, KEY_EVERY]);
    if (i % 150 === 0) process.stdout.write(`${name}: frame ${i}/${frames}\n`);
  }
  const { count, avcC } = await enc.page.evaluate(() => window.__finish());
  if (count !== frames) throw new Error(`${name}: encoder returned ${count} frames for ${frames} rendered`);
  const samples = [];
  for (let from = 0; from < count; from += 60) {
    const batch = await enc.page.evaluate(([a, b]) => window.__take(a, b), [from, from + 60]);
    for (const c of batch) samples.push({ data: Buffer.from(c.data, "base64"), ts: c.ts, key: c.key });
  }
  // Decode order must equal presentation order: one frame per timestamp, strictly increasing.
  samples.forEach((s, i) => {
    if (s.ts !== Math.round((i * 1e6) / FPS)) throw new Error(`${name}: frame ${i} out of order (ts ${s.ts})`);
  });
  const file = join(OUT, v.file);
  writeFileSync(file, writeMp4({ width: v.width, height: v.height, fps: FPS, avcC: Buffer.from(avcC, "base64"), samples }));
  await enc.page.close();
  await page.close();
  const mb = samples.reduce((a, s) => a + s.data.length, 0) / 1e6;
  console.log(
    `${name}: ${frames} frames, ${(frames / FPS).toFixed(2)} s, ${enc.codec}, ${mb.toFixed(1)} MB -> ${file} (${((Date.now() - started) / 1000).toFixed(0)} s)`,
  );
}

mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const wanted = args.filter((a) => a in VARIANTS);
const names = wanted.length ? wanted : Object.keys(VARIANTS);
const browser = await launch();
try {
  if (args.includes("--stills")) {
    const times = args.filter((a) => /^\d+(\.\d+)?$/.test(a)).map(Number);
    for (const name of names) await stills(browser, name, times);
  } else {
    for (const name of names) await render(browser, name);
  }
} finally {
  await browser.close();
}
