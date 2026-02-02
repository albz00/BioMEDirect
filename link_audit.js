const fs = require('fs');
const path = require('path');

const roots = ['TextT', 'TextX'];
const results = [];

function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(p);
        } else if (entry.name.toLowerCase().endsWith('.html')) {
            checkFile(p);
        }
    }
}

function collectTargets(src) {
    const out = [];
    const patterns = [
        /executeClick\s*\(\s*['"]([^'"]+)['"]/g,
        /executeClickNewWindow\s*\(\s*['"]([^'"]+)['"]/g,
        /self\.location\.href\s*=\s*['"]([^'"]+)['"]/g,
        /window\.location\.href\s*=\s*['"]([^'"]+)['"]/g,
        /onclick="window\.location\.href=['"]([^'"]+)['"]"/g,
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(src)) !== null) {
            out.push(m[1]);
        }
    }
    return out;
}

function checkFile(file) {
    const src = fs.readFileSync(file, 'utf8');
    const targets = collectTargets(src);
    const dir = path.dirname(file);
    for (const t of targets) {
        if (/^(https?:)?\/\//i.test(t)) continue;
        if (t.startsWith('mailto:')) continue;
        const resolved = path.normalize(path.join(dir, t));
        if (!fs.existsSync(resolved)) {
            results.push({ file, target: t });
        }
    }
}

for (const root of roots) {
    walk(path.join(__dirname, root));
}

console.log(JSON.stringify(results, null, 2));
