const fs = require('fs');
const path = require('path');

const root = process.cwd();
const auditPath = path.join(root, 'link_audit.json');
const data = JSON.parse(fs.readFileSync(auditPath, 'utf8').replace(/^\uFEFF/, ''));
const created = [];

for (const { file, target } of data) {
    const clean = target.split(/[?#]/)[0];
    const dest = path.normalize(path.join(path.dirname(file), clean));
    if (fs.existsSync(dest)) continue;

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const isT = file.includes('TextT');
    const isX = file.includes('TextX');
    const back = isT
        ? path.relative(path.dirname(dest), path.join(root, 'TextT', 'CentralMenuT.html'))
        : isX
        ? path.relative(path.dirname(dest), path.join(root, 'TextX', 'CentralMenuX.html'))
        : path.relative(path.dirname(dest), path.join(root, 'index.html'));

    const cssRel = path
        .relative(path.dirname(dest), path.join(root, 'CommonFiles', 'MasterLessons.css'))
        .replace(/\\/g, '/');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Placeholder</title>
  <link rel="stylesheet" href="${cssRel}">
</head>
<body style="font-family: Arial, sans-serif; background: #0a0a0a; color: #e6f8ff; padding: 2rem;">
  <h1>Placeholder</h1>
  <p>This page was auto-created because <code>${clean}</code> was missing (linked from <code>${path.relative(root, file)}</code>).</p>
  <div style="margin:1rem 0;">
    <button onclick="window.history.back()" style="padding:0.8rem 1.2rem; margin-right:0.6rem;">Go Back</button>
    <button onclick="window.location.href='${back.replace(/\\\\/g, '/')}'" style="padding:0.8rem 1.2rem;">Central Menu</button>
  </div>
</body>
</html>
`;

    fs.writeFileSync(dest, html, 'utf8');
    created.push(path.relative(root, dest));
}

console.log(`created ${created.length} files`);
if (created.length) {
    console.log(created.join('\n'));
}
