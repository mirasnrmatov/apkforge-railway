// src/icon.png (болмаса src/favicon.png) → build/icon.png: electron-builder оны .exe мен installer иконкасы етеді.
// Терезе иконкасын main.js src/ ішінен өзі алады.
// Workflow-да (және локальды тестте) `node set-icon.js` арқылы шақырылады.
const fs = require('fs');
const path = require('path');

const MIN_SIZE = 256;                                  // electron-builder Windows иконкасы үшін ең аз өлшем
const fail = (m) => { console.log(`::error::${m}`); process.exit(1); };

const name = ['icon.png', 'favicon.png'].find((f) => fs.existsSync(path.join(__dirname, 'src', f)));
if (!name) fail('Иконка табылмады (icon.png немесе favicon.png)');

const data = fs.readFileSync(path.join(__dirname, 'src', name));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (data.length < 24 || !data.subarray(0, 8).equals(PNG_MAGIC)) fail(`${name} PNG файл емес`);

// PNG IHDR: ені мен биіктігі 16–24 байтта
const width = data.readUInt32BE(16);
const height = data.readUInt32BE(20);
console.log(`Иконка: ${name} (${width}×${height})`);

if (width < MIN_SIZE || height < MIN_SIZE) {
  // Build-ті құлатпаймыз: терезе иконкасы бәрібір қойылады, .exe әдепкі Electron иконкасымен қалады
  console.log(`::warning::${name} ${width}×${height} — .exe иконкасы үшін кемі ${MIN_SIZE}×${MIN_SIZE} керек (512×512 ұсынылады). Тек терезе иконкасы қойылды.`);
  process.exit(0);
}
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'build', 'icon.png'), data);
console.log('build/icon.png жазылды');
