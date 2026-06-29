/**
 * Project-wide broken-link / missing-asset checker for the static site.
 *
 * Scans every .html file for local href/src references (CSS, JS, images,
 * thumbnails, zips, page links) and verifies the target exists on disk.
 *
 * Also flags case-only mismatches, which break on case-sensitive hosts
 * (e.g. Firebase Hosting / Linux) even though they resolve fine on Windows.
 *
 * Usage:  node scripts/check-broken-links.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Directories we never want to scan into.
const IGNORE_DIRS = new Set([".git", "node_modules", "functions"]);

// Reference schemes we should not treat as local files.
const SKIP_PREFIX = ["http:", "https:", "//", "mailto:", "tel:", "data:", "javascript:", "#"];

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), onFile);
    } else {
      onFile(path.join(dir, entry.name));
    }
  }
}

function extractRefs(html) {
  const refs = [];
  // Match href="..." and src="..." (single or double quotes).
  const re = /(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const val = (m[2] !== undefined ? m[2] : m[3]).trim();
    if (val) refs.push(val);
  }
  return refs;
}

function isSkippable(ref) {
  const lower = ref.toLowerCase();
  return SKIP_PREFIX.some((p) => lower.startsWith(p)) || ref === "";
}

// Cache of real, on-disk entries per directory for case-sensitivity checks.
const dirCache = new Map();
function listDir(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = null; // directory itself missing
  }
  dirCache.set(dir, entries);
  return entries;
}

/**
 * Returns: { status: "ok" | "missing" | "case", actual?: string }
 */
function resolveRef(htmlFile, ref) {
  // Strip query string and fragment.
  let clean = ref.split("#")[0].split("?")[0];
  if (!clean) return { status: "ok" }; // pure fragment/query

  // Decode percent-encoding (e.g. %20 -> space).
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* leave as-is if malformed */
  }

  const baseDir = path.dirname(htmlFile);
  const target = path.resolve(baseDir, clean);

  if (fs.existsSync(target)) {
    // Exists on (case-insensitive) Windows FS; verify exact-case match.
    const parentEntries = listDir(path.dirname(target));
    const name = path.basename(target);
    if (parentEntries && !parentEntries.includes(name)) {
      const ci = parentEntries.find((e) => e.toLowerCase() === name.toLowerCase());
      if (ci) return { status: "case", actual: ci };
    }
    return { status: "ok" };
  }
  return { status: "missing" };
}

// Tokens in a referenced path that mark it as an unfilled scaffold/template,
// not a real production link.
const PLACEHOLDER_TOKENS = [
  "ExcerptName",
  "LessonName",
  "PopUpName",
  "PlaceHolder",
  "QuestionBankLessonName",
  "ExcerptT.zip",
  "ExcerptX.zip",
  "ExcerptZ.zip",
  "ExcerptName.mp4",
  "popPopUpName",
];

function classify(ref, file) {
  if (/BioME(%20|\s)Sara/i.test(ref)) return "external";
  if (PLACEHOLDER_TOKENS.some((t) => ref.includes(t))) return "placeholder";
  // A reference embedded in a template file (filename itself a placeholder).
  const base = path.basename(file);
  if (/ExcerptName|LessonName|PopUpName|PlaceHolder/.test(base)) return "placeholder";
  // The "NameSide -->" garbage match is a parser artifact from a comment.
  if (ref.includes("<!DOCTYPE") || ref.includes("NameSide")) return "artifact";
  return "real";
}

const FIX_CASE = process.argv.includes("--fix-case");

const buckets = { real: new Map(), placeholder: new Map(), external: new Map(), artifact: new Map() };
const caseIssues = new Map(); // dedupe by `${ref} -> ${actual}`
const fileFixes = new Map(); // absPath -> [{from, to}]
let htmlCount = 0;
let refCount = 0;

function addMissing(bucket, ref, file) {
  const map = buckets[bucket];
  if (!map.has(ref)) map.set(ref, new Set());
  map.get(ref).add(file);
}

walk(ROOT, (file) => {
  if (!file.toLowerCase().endsWith(".html")) return;
  htmlCount++;
  const html = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  for (const ref of extractRefs(html)) {
    if (isSkippable(ref)) continue;
    refCount++;
    const res = resolveRef(file, ref);
    if (res.status === "missing") {
      addMissing(classify(ref, file), ref, rel);
    } else if (res.status === "case") {
      const key = `${ref} :: ${res.actual}`;
      if (!caseIssues.has(key)) caseIssues.set(key, { ref, actual: res.actual, files: new Set() });
      caseIssues.get(key).files.add(rel);
      if (FIX_CASE) {
        // Rebuild the corrected reference: same path, on-disk basename casing.
        const corrected = ref.replace(/[^\/\\?#]+(?=([?#]|$))/, res.actual);
        if (!fileFixes.has(file)) fileFixes.set(file, []);
        fileFixes.get(file).push({ from: ref, to: corrected });
      }
    }
  }
});

if (FIX_CASE) {
  let changedFiles = 0;
  let changedRefs = 0;
  for (const [absFile, fixes] of fileFixes) {
    let content = fs.readFileSync(absFile, "utf8");
    let touched = false;
    for (const { from, to } of fixes) {
      if (from === to) continue;
      if (content.includes(from)) {
        content = content.split(from).join(to);
        touched = true;
        changedRefs++;
      }
    }
    if (touched) {
      fs.writeFileSync(absFile, content);
      changedFiles++;
    }
  }
  console.log(`--fix-case: rewrote ${changedRefs} references in ${changedFiles} files to match on-disk casing.`);
  process.exit(0);
}

const out = [];
const log = (s = "") => out.push(s);

log(`Scanned ${htmlCount} HTML files, ${refCount} local references.\n`);

function dumpBucket(title, map) {
  const totalRefs = [...map.values()].reduce((n, s) => n + s.size, 0);
  log(`=== ${title} (${map.size} unique targets, ${totalRefs} references) ===`);
  const sorted = [...map.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [ref, files] of sorted) {
    const arr = [...files];
    log(`\n  [${arr.length}x] ${ref}`);
    for (const f of arr.slice(0, 6)) log(`        in ${f}`);
    if (arr.length > 6) log(`        ...and ${arr.length - 6} more`);
  }
  log("");
}

dumpBucket("REAL MISSING FILES (actionable)", buckets.real);

log(`=== CASE-ONLY MISMATCHES (${caseIssues.size} unique, break on case-sensitive hosts) ===`);
for (const { ref, actual, files } of caseIssues.values()) {
  log(`\n  ref:  ${ref}\n  disk: ${actual}   [${files.size}x]`);
  for (const f of [...files].slice(0, 6)) log(`        in ${f}`);
}
log("");

dumpBucket("TEMPLATE PLACEHOLDERS (expected - scaffold files)", buckets.placeholder);
dumpBucket("EXTERNAL-PROJECT REFS (BioME Sara, outside this repo)", buckets.external);
if (buckets.artifact.size) dumpBucket("PARSER ARTIFACTS (ignore)", buckets.artifact);

const report = out.join("\n");
const reportPath = path.join(__dirname, "broken-links-report.txt");
fs.writeFileSync(reportPath, report);
console.log(report);
console.log(`\nReport written to ${path.relative(ROOT, reportPath)}`);
