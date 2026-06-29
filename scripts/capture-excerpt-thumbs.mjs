/**
 * Capture a first-frame thumbnail for each Adobe Animate (CreateJS) excerpt
 * animation by rendering it in headless Chromium and screenshotting the canvas.
 *
 * Usage:
 *   node scripts/capture-excerpt-thumbs.mjs "<dir-with-excerpt-html>" [--frame N]
 *
 * Output: PNGs in "<dir>/Thumbnails/" named after each source file.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
// -1 = auto-detect the first meaningful frame; >=0 = force that frame index.
const frameIdx = (() => {
  const i = args.indexOf("--frame");
  if (i === -1) return -1;
  const v = parseInt(args[i + 1], 10);
  return Number.isNaN(v) ? -1 : v;
})();
const targetDir = path.resolve(ROOT, args.find((a) => !a.startsWith("--")) || ".");

// Identify Animate animation files (have a CreateJS canvas + properties block).
function isAnimateFile(content) {
  return content.includes('id="canvas"') && content.includes("lib.properties") && content.includes("createjs");
}

function getDimensions(content) {
  const w = /width:\s*(\d+)/.exec(content);
  const h = /height:\s*(\d+)/.exec(content);
  return { width: w ? +w[1] : 550, height: h ? +h[1] : 400 };
}

const isSingleFile = fs.existsSync(targetDir) && fs.statSync(targetDir).isFile();
const scanDir = isSingleFile ? path.dirname(targetDir) : targetDir;
const files = (isSingleFile ? [targetDir] : fs
  .readdirSync(targetDir)
  .filter((f) => f.toLowerCase().endsWith(".html"))
  .map((f) => path.join(targetDir, f)))
  .filter((f) => isAnimateFile(fs.readFileSync(f, "utf8")));

if (files.length === 0) {
  console.log(`No Adobe Animate excerpt files found in ${targetDir}`);
  process.exit(0);
}

const outDir = path.join(scanDir, "Thumbnails");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
let ok = 0;
let failed = [];

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  const { width, height } = getDimensions(content);
  const base = path.basename(file, ".html");
  const outPath = path.join(outDir, `${base}.png`);

  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  try {
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 30000 });
    // Wait for the CreateJS stage to be created by the file's init().
    await page.waitForFunction(() => window.stage && window.exportRoot, { timeout: 15000 });
    // Pick a frame to capture. The literal frame 0 of these Animate excerpts
    // is blank (they fade in), so unless an explicit --frame is given we scan
    // the timeline and stop on the first frame whose titled illustration is
    // actually visible (content-based), which is the meaningful "first frame".
    const info = await page.evaluate((forced) => {
      try {
        window.createjs.Ticker.removeAllEventListeners();
      } catch {}
      const root = window.stage.getChildAt(0);
      const tf = (root && root.totalFrames) || 1;
      const cv = document.getElementById("canvas");
      const ctx = cv.getContext("2d");

      function contentScore() {
        window.stage.update();
        const { width: w, height: h } = cv;
        const data = ctx.getImageData(0, 0, w, h).data;
        const br = data[0], bg = data[1], bb = data[2], ba = data[3];
        let diff = 0, total = 0;
        const step = Math.max(4, Math.floor((w * h) / 4000)) * 4;
        for (let o = 0; o < data.length; o += step) {
          const dr = data[o] - br, dg = data[o + 1] - bg, db = data[o + 2] - bb, da = data[o + 3] - ba;
          if (dr * dr + dg * dg + db * db + da * da > 900) diff++;
          total++;
        }
        return diff / total;
      }

      let target, bestScore = -1;
      if (forced >= 0) {
        target = Math.min(forced, tf - 1);
      } else {
        // Scan the timeline and pick the frame with the most rendered content
        // (the fully drawn illustration), skipping the blank fade-in frames.
        target = Math.floor(tf / 2);
        const samples = Math.min(40, Math.max(8, tf));
        for (let i = 0; i < samples; i++) {
          const f = Math.min(Math.floor((tf - 1) * (i / (samples - 1))), tf - 1);
          try {
            if (root.gotoAndStop) root.gotoAndStop(f);
            const s = contentScore();
            if (s > bestScore) { bestScore = s; target = f; }
          } catch (e) {
            /* a frame action threw; skip this frame */
          }
        }
      }
      try {
        if (root.gotoAndStop) root.gotoAndStop(target);
        window.stage.update();
      } catch (e) {}
      return { tf, target, score: Math.round(bestScore * 1000) / 1000 };
    }, frameIdx);
    await page.waitForTimeout(120); // let the canvas paint
    const canvas = await page.$("#canvas");
    await canvas.screenshot({ path: outPath });
    console.log(`OK  ${base}.png  (${width}x${height}, ${info.tf}f, @${info.target}, score=${info.score})`);
    ok++;
  } catch (err) {
    console.log(`ERR ${base}: ${err.message.split("\n")[0]}`);
    failed.push(base);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log(`\nDone. ${ok}/${files.length} captured -> ${path.relative(ROOT, outDir)}`);
if (failed.length) console.log(`Failed: ${failed.join(", ")}`);
