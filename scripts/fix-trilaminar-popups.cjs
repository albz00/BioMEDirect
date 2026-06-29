/**
 * TrilaminarX popup files whose on-disk names don't match the menu references:
 *   "popFirst Streak.html"          (space)      -> popFirstStreak.html
 *   "popHensen'sNodeComponents.html"(apostrophe) -> popHensensNodeComponents.html
 *   "popSteakComponents.html"       (typo)       -> popStreakComponents.html
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "TextX/LessonsX/EmbryologyX/TrilaminarX/PopUps");

const RENAMES = [
  ["popFirst Streak.html", "popFirstStreak.html"],
  ["popHensen'sNodeComponents.html", "popHensensNodeComponents.html"],
  ["popSteakComponents.html", "popStreakComponents.html"],
];

for (const [from, to] of RENAMES) {
  const fromAbs = path.join(DIR, from);
  const toAbs = path.join(DIR, to);
  if (!fs.existsSync(fromAbs)) {
    console.log(`SKIP (source missing): ${from}`);
    continue;
  }
  if (fs.existsSync(toAbs)) {
    console.log(`SKIP (target exists): ${to}`);
    continue;
  }
  try {
    execFileSync("git", ["mv", fromAbs, toAbs], { cwd: ROOT });
  } catch {
    fs.renameSync(fromAbs, toAbs);
  }
  console.log(`${from}  ->  ${to}`);
}
