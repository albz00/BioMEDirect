/**
 * Point the migrated TextX (No-Text) main lesson pages at videos/x/ by default.
 *
 * The ~51 migrated X pages fall back to `videos/${lessonId}.mp4` inside loadVideoUrl
 * when no videoPaths override exists. Since No-Text videos now live under videos/x/,
 * this rewrites that fallback to `videos/x/${lessonId}.mp4` so the page is correct even
 * before an admin upload/assign writes the override.
 *
 * Only X pages that are Firebase-wired (define `const lessonId` ending in _x and contain a
 * loadVideoUrl fallback to videos/${lessonId}.mp4) are touched. Idempotent: pages already
 * pointing at videos/x/ are skipped.
 *
 * Usage:
 *   node scripts/set-textx-default-path.cjs --dry   (report only, writes nothing)
 *   node scripts/set-textx-default-path.cjs         (apply changes)
 */
const fs = require("fs");
const path = require("path");

const DRY = process.argv.includes("--dry");
const repoRoot = path.join(__dirname, "..");
const xRoot = path.join(repoRoot, "TextX");

function findHtmlFiles(dir, list) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findHtmlFiles(full, list);
    else if (e.name.endsWith("X.html")) list.push(full);
  }
}

const OLD = "videoPath = `videos/${lessonId}.mp4`;";
const NEW = "videoPath = `videos/x/${lessonId}.mp4`;";

const xFiles = [];
findHtmlFiles(xRoot, xFiles);

let scanned = 0;
let changed = 0;
const updated = [];
const skipped = [];

for (const xFile of xFiles) {
  const content = fs.readFileSync(xFile, "utf8");

  // Only Firebase-wired X main pages with the default fallback.
  if (!content.includes("const lessonId") || !content.includes("loadVideoUrl(")) continue;
  scanned++;

  const rel = path.relative(repoRoot, xFile);
  if (content.includes(NEW)) {
    skipped.push(rel + " (already videos/x/)");
    continue;
  }
  if (!content.includes(OLD)) {
    skipped.push(rel + " (no default fallback found)");
    continue;
  }

  const next = content.replace(OLD, NEW);
  changed++;
  updated.push(rel);
  if (!DRY) fs.writeFileSync(xFile, next, "utf8");
}

console.log(`${DRY ? "[DRY] " : ""}Scanned ${scanned} Firebase-wired X pages.`);
console.log(`${DRY ? "Would update" : "Updated"} ${changed} page(s).`);
updated.forEach((f) => console.log("  + " + f));
if (skipped.length) {
  console.log(`Skipped ${skipped.length}:`);
  skipped.forEach((f) => console.log("  - " + f));
}
