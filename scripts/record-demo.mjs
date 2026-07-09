#!/usr/bin/env node
/**
 * scripts/record-demo.mjs — record a HIGH-RESOLUTION demo of the app.
 *
 * Opens a headed Chromium at 2x device pixels (retina-crisp UI) recording a
 * 3200×2000 video; you perform the demo by hand, close the window, and the
 * capture lands in docs/media/ as .webm plus (when ffmpeg is on PATH) a
 * README-ready high-res GIF.
 *
 *   node scripts/record-demo.mjs <name> [url]
 *     name  output basename → docs/media/<name>.webm / <name>.gif
 *     url   page to record (default http://localhost:5173)
 *
 * Requires playwright (not a repo dependency — the app itself never needs it):
 *   npm i --no-save playwright   # from any directory with a package.json
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2; // deviceScaleFactor — the whole point: 2x pixels everywhere
const GIF_FPS = 15;
const GIF_WIDTH = 1600; // GIF stays readable at README width; source is 3200px

const [name, url = "http://localhost:5173"] = process.argv.slice(2);
if (!name) {
  console.error("Usage: node scripts/record-demo.mjs <name> [url]");
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed. Run: npm i --no-save playwright");
  process.exit(1);
}

const mediaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "media");
const tmpDir = join(mediaDir, ".recording");
mkdirSync(tmpDir, { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: SCALE,
  recordVideo: {
    dir: tmpDir,
    size: { width: VIEWPORT.width * SCALE, height: VIEWPORT.height * SCALE },
  },
});
const page = await context.newPage();
await page.goto(url);

console.log("Recording… perform the demo, then CLOSE the browser window.");
await page.waitForEvent("close", { timeout: 0 });
await context.close(); // flushes the video file
await browser.close();

const rawName = readdirSync(tmpDir).find((f) => f.endsWith(".webm"));
if (!rawName) {
  console.error("No video was produced.");
  process.exit(1);
}
const webm = join(mediaDir, `${name}.webm`);
renameSync(join(tmpDir, rawName), webm);
rmSync(tmpDir, { recursive: true, force: true });
console.log(`Saved ${webm} (${VIEWPORT.width * SCALE}×${VIEWPORT.height * SCALE})`);

// GIF via ffmpeg two-pass palette (best quality/size for UI captures).
const gif = join(mediaDir, `${name}.gif`);
const ff = spawnSync(
  "ffmpeg",
  [
    "-y", "-i", webm,
    "-vf",
    `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
    gif,
  ],
  { stdio: "inherit" },
);
if (ff.status === 0) {
  console.log(`Saved ${gif}`);
} else {
  console.log("ffmpeg not available — kept the .webm only.");
}
