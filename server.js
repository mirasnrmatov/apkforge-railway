const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- жолдар ----
const ROOT = __dirname;
const TEMPLATE_DIR = path.join(ROOT, 'template');      // таза Android шаблоны
const WORK_DIR = path.join(ROOT, 'work');              // әр build уақытша осында
const OUTPUT_DIR = path.join(ROOT, 'output');          // дайын APK-лар

for (const d of [WORK_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.use(cors());
app.use(express.static(path.join(ROOT, 'public')));    // дизайн осында

const upload = multer({ dest: path.join(ROOT, 'uploads') });

// ---- көмекші: папканы рекурсивті көшіру ----
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---- көмекші: файлда токен алмастыру ----
function replaceInFile(file, replacements) {
  let txt = fs.readFileSync(file, 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    txt = txt.split(token).join(value);
  }
  fs.writeFileSync(file, txt);
}

// ---- негізгі build маршруты ----
app.post('/api/build', upload.single('zip'), async (req, res) => {
  const jobId = 'job_' + Date.now();
  const jobDir = path.join(WORK_DIR, jobId);
  const log = [];
  const add = (m) => { log.push(m); console.log(m); };

  try {
    // 1) параметрлер
    const appName = (req.body.appName || 'MyApp').trim();
    const pkg = (req.body.pkg || 'com.apkforge.app').trim();
    const color = (req.body.color || '#3DD4C8').trim();
    if (!req.file) throw new Error('ZIP файл жүктелмеді');

    // package ID тексеру (қарапайым)
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg)) {
      throw new Error('Package ID форматы қате (мыс. com.mysite.app)');
    }

    // 2) шаблонды көшіру
    add('Шаблон көшірілуде...');
    copyDir(TEMPLATE_DIR, jobDir);

    // 3) ZIP-ті assets/www ішіне ашу
    add('ZIP ашылуда...');
    const wwwDir = path.join(jobDir, 'app', 'src', 'main', 'assets', 'www');
    fs.rmSync(wwwDir, { recursive: true, force: true });
    fs.mkdirSync(wwwDir, { recursive: true });
    new AdmZip(req.file.path).extractAllTo(wwwDir, true);

    // егер ZIP ішінде бір ғана папка болса, оны жайып жіберу
    const items = fs.readdirSync(wwwDir);
    if (items.length === 1 && fs.statSync(path.join(wwwDir, items[0])).isDirectory()) {
      const inner = path.join(wwwDir, items[0]);
      for (const f of fs.readdirSync(inner)) {
        fs.renameSync(path.join(inner, f), path.join(wwwDir, f));
      }
      fs.rmdirSync(inner);
    }
    if (!fs.existsSync(path.join(wwwDir, 'index.html'))) {
      throw new Error('ZIP ішінде index.html табылмады');
    }
    add('index.html табылды');

    // 4) токендерді алмастыру
    add('Параметрлер жазылуда...');
    replaceInFile(path.join(jobDir, 'app', 'build.gradle'), {
      '__APPLICATION_ID__': pkg,
      '__VERSION_CODE__': '1',
      '__VERSION_NAME__': '1.0',
    });
    replaceInFile(path.join(jobDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml'), {
      '__APP_NAME__': appName,
    });
    replaceInFile(path.join(jobDir, 'app', 'src', 'main', 'res', 'values', 'colors.xml'), {
      '__THEME_COLOR__': color,
    });

    // 5) local.properties — SDK жолы
    const sdkDir = (process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME ||
      path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk')).replace(/\\/g, '\\\\');
    fs.writeFileSync(path.join(jobDir, 'local.properties'), `sdk.dir=${sdkDir}\n`);

    // 6) gradle build
    add('gradle assembleRelease орындалуда... (бірінші рет бірнеше минут)');
    const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    // Linux-та gradlew файлына орындау рұқсатын беру
    if (process.platform !== 'win32') {
      try { fs.chmodSync(path.join(jobDir, 'gradlew'), 0o755); } catch (e) {}
    }
    await new Promise((resolve, reject) => {
      execFile(gradlew, ['assembleRelease', '--no-daemon'], {
        cwd: jobDir, shell: true, maxBuffer: 1024 * 1024 * 50,
      }, (err, stdout, stderr) => {
        if (err) { add(stderr || stdout); reject(new Error('Gradle build сәтсіз аяқталды')); }
        else resolve();
      });
    });

    // 7) APK-ны output-қа көшіру
    const apkSrc = path.join(jobDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    if (!fs.existsSync(apkSrc)) throw new Error('APK табылмады (build мәселесі)');
    const safeName = appName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'app';
    const apkDest = path.join(OUTPUT_DIR, `${safeName}-${jobId}.apk`);
    fs.copyFileSync(apkSrc, apkDest);
    add('BUILD SUCCESSFUL');

    res.json({
      ok: true,
      log,
      download: `/api/download/${path.basename(apkDest)}`,
      size: (fs.statSync(apkDest).size / 1024 / 1024).toFixed(1) + ' MB',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, log });
  } finally {
    // уақытша файлдарды тазалау
    if (req.file) fs.rmSync(req.file.path, { force: true });
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

// ---- APK жүктеу ----
app.get('/api/download/:name', (req, res) => {
  const file = path.join(OUTPUT_DIR, path.basename(req.params.name));
  if (fs.existsSync(file)) res.download(file);
  else res.status(404).send('Файл табылмады');
});

app.listen(PORT, () => {
  console.log(`\n  APKForge сервері іске қосылды`);
  console.log(`  Браузерде аш: http://localhost:${PORT}\n`);
});
