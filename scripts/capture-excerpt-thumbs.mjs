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
const frameIdx = (() => {
  const i = args.indexOf("--frame");
  return i !== -1 ? parseInt(args[i + 1], 10) || 0 : 0;
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

const files = fs
  .readdirSync(targetDir)
  .filter((f) => f.toLowerCase().endsWith(".html"))
  .map((f) => path.join(targetDir, f))
  .filter((f) => isAnimateFile(fs.readFileSync(f, "utf8")));

if (files.length === 0) {
  console.log(`No Adobe Animate excerpt files found in ${targetDir}`);
  process.exit(0);
}

const outDir = path.join(targetDir, "Thumbnails");
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
    // Freeze on the requested frame so the capture is deterministic.
    await page.evaluate((idx) => {
      try {
        window.createjs.Ticker.removeAllEventListeners();
      } catch {}
      const root = window.stage.getChildAt(0);
      if (root && typeof root.gotoAndStop === "function") root.gotoAndStop(idx);
      window.stage.update();
    }, frameIdx);
    await page.waitForTimeout(150); // let the canvas paint
    const canvas = await page.$("#canvas");
    await canvas.screenshot({ path: outPath });
    console.log(`OK  ${base}.png  (${width}x${height})`);
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
