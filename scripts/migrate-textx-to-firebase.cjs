/**
 * Migrate TextX (No-Text) main lesson pages to the Firebase loader.
 *
 * For every migrated TextT main page (one that defines `const lessonId` and calls
 * `initializePlayer`), this finds the parallel TextX twin and switches its MAIN video +
 * timeline to Firebase, mirroring the proven TextT wiring, while keeping the X page's own
 * body (nav back to the T twin, side videos, popups) AND its side-array includes intact.
 *
 * Per X page it:
 *   1. Inserts the Firebase SDK + ApplyLessonChapterOverrides.js includes into <head>.
 *   2. Removes the main video's local <source> (id="videoSrc"); side-video sources stay.
 *   3. Rewrites the trailing scripts: drops the main {Stem}X_src_array.js, the static
 *      jQuery, masterUIcontrol.js, and {Stem}X.js includes; KEEPS every side-array
 *      include (e.g. Fpump/FpumpX_src_array.js, Bang/BangX_src_array.js); then appends the
 *      uniform Firebase loader block (lessonId = the T twin's id with _t->_x; lesson script
 *      = {Stem}X.js). The loader dynamically loads masterUIcontrol.js + the lesson script.
 *   4. Strips a stray leading `html` typo before <!DOCTYPE html> if present.
 *
 * Side arrays define their own globals (e.g. var srcArray_Fpump), so keeping them is safe;
 * only the main file's `var srcArray` would collide with the Firebase-loaded window.srcArray,
 * which is why only the main include is removed.
 *
 * Usage:
 *   node scripts/migrate-textx-to-firebase.cjs --dry   (report only, writes nothing)
 *   node scripts/migrate-textx-to-firebase.cjs         (apply changes)
 */
const fs = require("fs");
const path = require("path");

const DRY = process.argv.includes("--dry");
const repoRoot = path.join(__dirname, "..");
const tRoot = path.join(repoRoot, "TextT");
const xRoot = path.join(repoRoot, "TextX");

const HEAD_INCLUDES = `    <!-- Firebase SDKs -->
    <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-storage-compat.js"></script>
    <script src="../../../../CommonFiles/ApplyLessonChapterOverrides.js"></script>
`;

// Uniform Firebase loader block (jQuery tag + inline script), mirroring the migrated TextT
// pages. __LESSONID__ and __STEM__ are replaced per page. Inner backticks/`${}` are escaped
// so they survive into the generated HTML verbatim.
const FIREBASE_BLOCK_TEMPLATE = `<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.4.1/jquery.min.js"></script>
<script>
    // Initialize Firebase
    const firebaseConfig = {
        apiKey: "AIzaSyB0KbGW-4znfF19ikrUahdCyd_bEungkH4",
        authDomain: "biome-865cc.firebaseapp.com",
        projectId: "biome-865cc",
        storageBucket: "biome-865cc.firebasestorage.app",
        messagingSenderId: "952652458408",
        appId: "1:952652458408:web:23e7f0689e9cf973be959d"
    };
    firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    window.shouldSkipYellow = false;
    window.yellowScreenRanges = [];

        // Load srcArray from Firestore (timeline keyed by lessonId only)
    async function loadSrcArray(lessonId) {
        try {
            const lessonDoc = await db.collection("lessons").doc(lessonId).get();
            if (!lessonDoc.exists) return [];
            const data = lessonDoc.data() || {};
            applyLessonMarkerGlobalsFromFirestoreData(data);
            return data.srcArray || [];
        } catch (error) {
            console.error("Error loading srcArray:", error);
            return [];
        }
    }

    // Load video URL from Firebase Storage
    async function loadVideoUrl(lessonId) {
        try {
            // Check videoPaths collection for custom videoPath
            const videoPathDoc = await db.collection("videoPaths").doc(lessonId).get();
            let videoPath;

            if (videoPathDoc.exists && videoPathDoc.data().videoPath) {
                // Use custom video path from videoPaths collection
                videoPath = videoPathDoc.data().videoPath;
            } else {
                // Fall back to default path
                videoPath = \`videos/\${lessonId}.mp4\`;
            }

            const storageRef = firebase.storage().ref();
            const fileRef = storageRef.child(videoPath);
            return await fileRef.getDownloadURL();
        } catch (error) {
            console.error('Error loading video URL:', error);
            // Return null if video doesn't exist, don't break the page
            return null;
        }
    }

    // Load masterUIcontrol.js first
    const masterUIScript = document.createElement('script');
    masterUIScript.src = '../../../../CommonFiles/masterUIcontrol.js';
    document.body.appendChild(masterUIScript);

    masterUIScript.onload = function() {
        // Load srcArray from Firestore and initialize player
        (async () => {
            const lessonId = "__LESSONID__";

            const srcArray = await loadSrcArray(lessonId);
            const videoUrl = await loadVideoUrl(lessonId);

            if (!window.shouldSkipColorCards && !window.shouldSkipYellow &&
                ((window.yellowScreenRanges && window.yellowScreenRanges.length > 0) ||
                 (window.greenDetection && window.greenDetection.events && window.greenDetection.events.length > 0))) {
                window.shouldSkipColorCards = true;
                window.shouldSkipYellow = true;
            }

            console.log("Loaded timing array:", srcArray);
            console.log("Loaded video URL:", videoUrl);

            // Always initialize player to set window.srcArray (required by masterUIcontrol.js)
            if (videoUrl && srcArray && srcArray.length > 0) {
                initializePlayer(videoUrl, srcArray);
            } else {
                console.warn("Video URL or srcArray missing. Video URL:", videoUrl, "srcArray length:", srcArray ? srcArray.length : 0);
                // Always initialize with at least empty array to prevent "srcArray is not defined" errors
                initializePlayer(videoUrl || "", srcArray || []);
            }

            // Load lesson-specific script
            const lessonScript = document.createElement('script');
            lessonScript.src = '__STEM__.js';
            document.body.appendChild(lessonScript);
        })();
    };
</script>`;

function findHtmlFiles(dir, list) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findHtmlFiles(full, list);
    else if (e.name.endsWith("T.html")) list.push(full);
  }
}

// Map a TextT path to its TextX twin by flipping the trailing T of each segment.
function toXPath(tFile) {
  const rel = path.relative(tRoot, tFile);
  const relX = rel.replace(/T([\\/]|\.html$)/g, "X$1");
  return path.join(xRoot, relX);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const tFiles = [];
findHtmlFiles(tRoot, tFiles);

let targeted = 0;
let written = 0;
const missing = [];
const skipped = [];
const keptSide = [];

for (const tFile of tFiles) {
  const tContent = fs.readFileSync(tFile, "utf8");

  // Only migrated main lesson pages (Firebase-wired). Excludes PopUps/Excerpts/Questions/etc.
  if (!tContent.includes("const lessonId") || !tContent.includes("initializePlayer(")) continue;

  const lessonIdMatch = tContent.match(/const\s+lessonId\s*=\s*"([^"]+)"/);
  if (!lessonIdMatch) continue;
  const tId = lessonIdMatch[1];
  const xId = tId.replace(/_t$/, "_x");

  const xFile = toXPath(tFile);
  const relX = path.relative(repoRoot, xFile);

  if (!fs.existsSync(xFile)) {
    missing.push(relX);
    continue;
  }
  targeted++;

  const stemX = path.basename(xFile, ".html"); // e.g. TransportProteinsX
  let x = fs.readFileSync(xFile, "utf8");
  const before = x;
  const actions = [];

  // 1. Strip stray leading `html` before <!DOCTYPE html>.
  if (/^\s*html\s*<!DOCTYPE/i.test(x)) {
    x = x.replace(/^\s*html\s*(?=<!DOCTYPE)/i, "");
    actions.push("fix-leading-html");
  }

  // 2. Insert Firebase head includes (idempotent).
  if (!x.includes("firebase-app-compat.js")) {
    if (!x.includes("</head>")) { skipped.push(`${relX} (no </head>)`); continue; }
    x = x.replace("</head>", HEAD_INCLUDES + "</head>");
    actions.push("add-head-includes");
  }

  // 3. Remove the main video's local <source> (id="videoSrc"); keep side-video sources.
  if (/<source[^>]*id="videoSrc"[^>]*>/.test(x)) {
    x = x.replace(/[ \t]*<source[^>]*id="videoSrc"[^>]*>\s*\r?\n?/, "");
    actions.push("remove-main-source");
  } else {
    actions.push("WARN:no-videoSrc");
  }

  // 4. Rebuild the trailing <script> region (between </body> and </html>).
  const xBodyEnd = x.lastIndexOf("</body>");
  const xHtmlEnd = x.lastIndexOf("</html>");
  if (xBodyEnd === -1 || xHtmlEnd === -1 || xHtmlEnd < xBodyEnd) {
    skipped.push(`${relX} (could not locate X trailing block)`);
    continue;
  }
  const tail = x.slice(xBodyEnd + "</body>".length, xHtmlEnd);
  const tailLines = tail.split(/\r?\n/);

  const mainSrcArrayRe = new RegExp(`<script[^>]*src="${escapeRe(stemX)}_src_array\\.js"[^>]*></script>`);
  const lessonJsRe = new RegExp(`<script[^>]*src="${escapeRe(stemX)}\\.js"[^>]*></script>`);
  const jqueryRe = /<script[^>]*ajax\.googleapis\.com\/ajax\/libs\/jquery/;
  const masterRe = /<script[^>]*masterUIcontrol\.js"[^>]*><\/script>/;

  const kept = [];
  for (const line of tailLines) {
    if (line.trim() === "") continue;
    if (mainSrcArrayRe.test(line)) continue;
    if (lessonJsRe.test(line)) continue;
    if (jqueryRe.test(line)) continue;
    if (masterRe.test(line)) continue;
    kept.push(line); // side-array includes, comments, anything else stays
  }

  const sideKept = kept.filter(l => /_src_array\.js/.test(l));
  if (sideKept.length) keptSide.push(`${relX}  (+${sideKept.length} side: ${sideKept.map(s => (s.match(/src="([^"]+)"/) || [])[1]).join(", ")})`);

  const block = FIREBASE_BLOCK_TEMPLATE
    .replace("__LESSONID__", xId)
    .replace("__STEM__", stemX);

  const newTail = "\n\n" + (kept.length ? kept.join("\n") + "\n" : "") + block + "\n";
  x = x.slice(0, xBodyEnd + "</body>".length) + newTail + x.slice(xHtmlEnd);
  actions.push("rebuild-tail");

  if (x === before) { skipped.push(`${relX} (no change)`); continue; }

  if (DRY) {
    console.log(`WOULD UPDATE: ${relX}  [${actions.join(", ")}]  lessonId=${xId}`);
  } else {
    fs.writeFileSync(xFile, x);
    written++;
    console.log(`Updated: ${relX}  [${actions.join(", ")}]  lessonId=${xId}`);
  }
}

console.log("\n----- summary -----");
console.log(`X twins targeted: ${targeted}`);
if (keptSide.length) {
  console.log(`Pages keeping side-arrays: ${keptSide.length}`);
  keptSide.forEach(f => console.log(`   ${f}`));
}
if (missing.length) {
  console.log(`Missing X twins (skipped): ${missing.length}`);
  missing.forEach(f => console.log(`   missing: ${f}`));
}
if (skipped.length) {
  console.log(`Skipped: ${skipped.length}`);
  skipped.forEach(f => console.log(`   skip: ${f}`));
}
console.log(DRY ? "\nDRY RUN - no files written." : `\nDone. Wrote ${written} files.`);
