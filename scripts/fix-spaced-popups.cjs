/**
 * The X-version PopUps for TeratologyX and UrogenitalX were saved with a space
 * after "pop"/"AllPops" (e.g. "pop KidneyAscent.html"), but every reference
 * (and the matching T-version files) uses the space-less form. This renames the
 * spaced files to the referenced, space-less names via `git mv`.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIRS = [
  "TextX/LessonsX/EmbryologyX/TeratologyX/PopUps",
  "TextX/LessonsX/EmbryologyX/UrogenitalX/PopUps",
];

let renamed = 0;
for (const rel of DIRS) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!name.includes(" ")) continue;
    const target = name.replace(/ /g, "");
    const fromAbs = path.join(dir, name);
    const toAbs = path.join(dir, target);
    if (fs.existsSync(toAbs)) {
      console.log(`SKIP (target exists): ${rel}/${name}`);
      continue;
    }
    try {
      execFileSync("git", ["mv", fromAbs, toAbs], { cwd: ROOT });
    } catch {
      fs.renameSync(fromAbs, toAbs); // fall back if not tracked yet
    }
    console.log(`${rel}/${name}  ->  ${target}`);
    renamed++;
  }
}
console.log(`\nRenamed ${renamed} files.`);
