/**
 * Patch lesson *T.html loadSrcArray to call applyLessonMarkerGlobalsFromFirestoreData(data)
 * so the player receives yellow, green, and red marker fields from Firestore.
 */
const fs = require("fs");
const path = require("path");

function findHtmlFiles(dir, list) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findHtmlFiles(full, list);
    else if (e.name.endsWith("T.html")) list.push(full);
  }
}

const APPLY_LINE = "            applyLessonMarkerGlobalsFromFirestoreData(data);";

function patchLoadSrcArray(content) {
  if (!content.includes("async function loadSrcArray")) return { content, changed: false };
  if (content.includes("applyLessonMarkerGlobalsFromFirestoreData")) return { content, changed: false };

  const marker = "const data = lessonDoc.data() || {};";
  if (!content.includes(marker)) return { content, changed: false };

  let changed = false;
  let next = content;

  if (next.includes(marker)) {
    const reYellow = /\s*if \(Array\.isArray\(data\.yellowScreenRanges\)\) window\.yellowScreenRanges = data\.yellowScreenRanges;\s*\n/g;
    const reYellowStop = /\s*if \(Array\.isArray\(data\.yellowStopMarkers\)\) window\.yellowStopMarkers = data\.yellowStopMarkers;\s*\n/g;
    const reGreen = /\s*if \(data\.greenDetection\) window\.greenDetection = data\.greenDetection;\s*\n/g;
    if (reYellow.test(next) || reYellowStop.test(next) || reGreen.test(next)) {
      next = next.replace(reYellow, "\n");
      next = next.replace(reYellowStop, "\n");
      next = next.replace(reGreen, "\n");
      changed = true;
    }
    if (!next.includes(APPLY_LINE)) {
      next = next.replace(
        marker,
        marker + "\n" + APPLY_LINE
      );
      changed = true;
    }
  }

  const skipOld = "if (window.yellowScreenRanges && window.yellowScreenRanges.length > 0) window.shouldSkipYellow = true;";
  const skipNew = "if (!window.shouldSkipColorCards && !window.shouldSkipYellow &&\n                ((window.yellowScreenRanges && window.yellowScreenRanges.length > 0) ||\n                 (window.greenDetection && window.greenDetection.events && window.greenDetection.events.length > 0))) {\n                window.shouldSkipColorCards = true;\n                window.shouldSkipYellow = true;\n            }";
  if (next.includes(skipOld)) {
    next = next.replace(skipOld, skipNew);
    changed = true;
  }

  return { content: next, changed };
}

const roots = [
  path.join(__dirname, "..", "TextT"),
  path.join(__dirname, "..", "TextX"),
];
let updated = 0;
for (const root of roots) {
  const files = [];
  findHtmlFiles(root, files);
  for (const file of files) {
    const original = fs.readFileSync(file, "utf8");
    const { content, changed } = patchLoadSrcArray(original);
    if (changed) {
      fs.writeFileSync(file, content);
      updated++;
      console.log("Updated:", path.relative(path.join(__dirname, ".."), file));
    }
  }
}
console.log("Done. Updated", updated, "lesson HTML files.");
