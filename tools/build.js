// Bundles src/ into one self-contained file: index.html in the repository root.
// Run: node tools/build.js
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src');
const read = (name) => fs.readFileSync(path.join(src, name), 'utf8');

let html = read('index.html');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/, (_, file) => `<style>\n${read(file)}</style>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, file) =>
  `<script>\n${read(file).replace(/<\/script/gi, '<\/script')}</script>`);
if (/<script src=|<link rel="stylesheet"/.test(html)) throw new Error('Something was not inlined.');

const out = path.join(__dirname, '..', 'index.html');
fs.writeFileSync(out, html);
console.log(`wrote ${path.basename(out)} (${Math.round(html.length / 1024)} KB)`);
