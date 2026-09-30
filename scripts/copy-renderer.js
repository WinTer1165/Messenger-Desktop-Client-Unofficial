/**
 * Copy the renderer's HTML (the title bar document) into dist/ next to
 * the compiled TypeScript. tsc only emits .js, and with no .ts file left
 * in src/renderer it doesn't create dist/renderer at all.
 */

const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'src', 'renderer');
const to = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(to, { recursive: true });

for (const file of fs.readdirSync(from)) {
  if (file.endsWith('.html')) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
  }
}
