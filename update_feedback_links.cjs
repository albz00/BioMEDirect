const fs = require('fs');
const path = require('path');

const root = process.cwd();
const commonFeedback = path.join(root, 'CommonFiles', 'FeedbackNetlify.html');

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.toLowerCase().endsWith('.html')) fixFile(p);
  }
}

function fixFile(file) {
  let src = fs.readFileSync(file, 'utf8');
  const re = /executeClick\(["']Feedback[^"']*?\.cfm["']\)/g;
  if (!re.test(src)) return;

  const lessonName = path.basename(file, path.extname(file));
  const rel = path
    .relative(path.dirname(file), commonFeedback)
    .replace(/\\/g, '/');
  const replacement = `executeClick("${rel}?lesson=${lessonName}")`;

  const updated = src.replace(re, replacement);
  if (updated !== src) {
    fs.writeFileSync(file, updated, 'utf8');
    console.log('updated feedback link:', path.relative(root, file), '->', replacement);
  }
}

walk(path.join(root, 'TextT'));
walk(path.join(root, 'TextX'));
