/**
 * Add yellow-screen skip globals and logic to all lesson *T.html that use
 * loadSrcArray(lessonId) but don't yet set yellowScreenRanges / shouldSkipYellow.
 */
const fs = require("fs");
const path = require("path");

const GLOBALS_TO_ADD = `    window.shouldSkipYellow = false;
    window.yellowScreenRanges = [];

    `;

const LOAD_SRCARRAY_OLD = `    // Load srcArray from Firestore (timeline keyed by lessonId only)
    async function loadSrcArray(lessonId) {
        try {
            const lessonDoc = await db.collection("lessons").doc(lessonId).get();
            if (!lessonDoc.exists) return [];
            return (lessonDoc.data().srcArray) || [];
        } catch (error) {
            console.error("Error loading srcArray:", error);
            return [];
        }
    }`;

const LOAD_SRCARRAY_NEW = `    // Load srcArray from Firestore (timeline keyed by lessonId only)
    async function loadSrcArray(lessonId) {
        try {
            const lessonDoc = await db.collection("lessons").doc(lessonId).get();
            if (!lessonDoc.exists) return [];
            const data = lessonDoc.data() || {};
            if (Array.isArray(data.yellowScreenRanges)) window.yellowScreenRanges = data.yellowScreenRanges;
            return data.srcArray || [];
        } catch (error) {
            console.error("Error loading srcArray:", error);
            return [];
        }
    }`;

const AFTER_LOAD_VIDEO_OLD = `            const srcArray = await loadSrcArray(lessonId);
            const videoUrl = await loadVideoUrl(lessonId);

            console.log("Loaded timing array:", srcArray);`;

const AFTER_LOAD_VIDEO_NEW = `            const srcArray = await loadSrcArray(lessonId);
            const videoUrl = await loadVideoUrl(lessonId);

            if (window.yellowScreenRanges && window.yellowScreenRanges.length > 0) window.shouldSkipYellow = true;

            console.log("Loaded timing array:", srcArray);`;

function findHtmlFiles(dir, list) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findHtmlFiles(full, list);
    else if (e.name.endsWith("T.html")) list.push(full);
  }
}

const root = path.join(__dirname, "..", "TextT");
const files = [];
findHtmlFiles(root, files);

let updated = 0;
for (const file of files) {
  let content = fs.readFileSync(file, "utf8");
  // Skip Orientations (already has full yellow logic)
  if (content.includes("orientations_t") && content.includes("window.yellowScreenRanges = data.yellowScreenRanges")) continue;
  if (!content.includes("// Load srcArray from Firestore (timeline keyed by lessonId only)")) continue;
  if (!content.includes("loadVideoUrl(lessonId)")) continue;
  let changed = false;
  // Add globals after "const db = firebase.firestore();" if not present
  if (!content.includes("window.shouldSkipYellow")) {
    content = content.replace("const db = firebase.firestore();\n\n    // Load srcArray", "const db = firebase.firestore();\n" + GLOBALS_TO_ADD + "    // Load srcArray");
    changed = true;
  }
  if (content.includes("return (lessonDoc.data().srcArray) || []") && !content.includes("data.yellowScreenRanges")) {
    content = content.replace(LOAD_SRCARRAY_OLD, LOAD_SRCARRAY_NEW);
    changed = true;
  }
  if (content.includes("const videoUrl = await loadVideoUrl(lessonId);") && !content.includes("window.shouldSkipYellow = true")) {
    content = content.replace(AFTER_LOAD_VIDEO_OLD, AFTER_LOAD_VIDEO_NEW);
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(file, content);
    updated++;
    console.log("Updated:", path.relative(root, file));
  }
}
console.log("Done. Updated", updated, "files.");
