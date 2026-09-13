// APKForge сервері.
// Build Railway-де емес, GitHub Actions runner-де жүреді:
//   android → .github/workflows/build-apk.yml         (HTML/CSS/JS ZIP → .apk)
//   python  → .github/workflows/build-exe-python.yml  (.py немесе ZIP → Windows .exe, PyInstaller)
//   desktop → .github/workflows/build-desktop-electron.yml (HTML/CSS/JS ZIP → Windows Setup .exe, Electron)
//   1) /api/build файлды уақытша сақтап, оған құпия URL жасайды да, workflow_dispatch жібереді
//   2) сервер фонда run күйін бақылайды (run-name ішінде jobId бар)
//   3) run сәтті аяқталса, artifact-ты жүктеп, /api/download арқылы береді

const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;             // Railway PORT-ты өзі береді

// ---- GitHub баптаулары (Railway Variables) ----
const GH = {
  token: process.env.GITHUB_TOKEN,
  owner: process.env.GITHUB_REPO_OWNER,
  repo: process.env.GITHUB_REPO_NAME,
  branch: process.env.GITHUB_BRANCH || 'main',
  api: (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
};
const ghConfigured = () => Boolean(GH.token && GH.owner && GH.repo);
const repoPath = () => `/repos/${encodeURIComponent(GH.owner)}/${encodeURIComponent(GH.repo)}`;

// ---- уақыт шектері ----
const POLL_MS = 6000;                              // GitHub API-ды қаншалықты жиі сұрау
const FIND_RUN_TIMEOUT_MS = 3 * 60 * 1000;         // dispatch-тан кейін run пайда болуы керек уақыт
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;           // бүкіл build үшін шек
const JOB_TTL_MS = 60 * 60 * 1000;                 // аяқталған job пен дайын файл 1 сағат сақталады
const MAX_ZIP_BYTES = 100 * 1024 * 1024;

// Пайдаланушы қатесі (400) — серверлік қатеден (500) ажырату үшін
class UserError extends Error {}

// Workflow қадамдарына ортақ хабарлар
const COMMON_HINTS = {
  'ZIP жүктеу': 'Runner ZIP файлды жүктей алмады (сервердің public домені қолжетімді ме?)',
};

// ---- ZIP көмекшілері ----
// ZIP ішіндегі файлдар тізімі — workflow-дағы ереже бойынша:
// __MACOSX пен түбірдегі .DS_Store алынып тасталады, жалғыз түбір папка жайылады.
// Жайылған папканың аты names.stripped ішінде сақталады (мыс. 'proj/').
function zipFileList(file) {
  let names;
  try {
    names = new AdmZip(file).getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => e.entryName.replace(/\\/g, '/'))
      .filter((n) => !n.startsWith('__MACOSX/') && n !== '.DS_Store');
  } catch {
    throw new UserError('Жүктелген файл ZIP емес немесе бұзық');
  }
  const tops = new Set(names.map((n) => n.split('/')[0]));
  let stripped = '';
  if (tops.size === 1 && names.every((n) => n.includes('/'))) {
    stripped = [...tops][0] + '/';
    names = names.map((n) => n.slice(stripped.length));
  }
  names.stripped = stripped;
  return names;
}

// multer (busboy) файл атауын latin1 деп оқиды — UTF-8-ке қайтарамыз
const originalName = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

// ---- Python көмекшілері ----
// Workflow-дағы тексерумен бірдей: ZIP ішіндегі салыстырмалы жол, латын таңбалары, .py
const ENTRY_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.py$/;
const validEntry = (p) => ENTRY_RE.test(p) && !p.includes('..');

function resolveEntryPoint(names, requested) {
  const pyFiles = names.filter((n) => n.endsWith('.py'));
  if (!pyFiles.length) throw new UserError('ZIP ішінде .py файл жоқ');

  if (requested) {
    requested = requested.replace(/\\/g, '/').replace(/^\.\//, '');
    // Пайдаланушы ZIP-тегі толық жолды жазса (мыс. proj/main.py), жайылған папканы алып тастаймыз
    if (names.stripped && requested.startsWith(names.stripped) && !names.includes(requested)) {
      requested = requested.slice(names.stripped.length);
    }
    if (!validEntry(requested)) {
      throw new UserError('Entry point форматы қате (мыс. main.py немесе app/main.py, тек латын әріптері)');
    }
    if (!names.includes(requested)) throw new UserError(`ZIP ішінде ${requested} табылмады`);
    return requested;
  }
  // Entry point көрсетілмесе — әдеттегі атаулар, болмаса түбірдегі жалғыз .py
  const rootPy = pyFiles.filter((n) => !n.includes('/'));
  const found = ['main.py', '__main__.py', 'app.py'].find((n) => names.includes(n)) ||
    (rootPy.length === 1 ? rootPy[0] : null);
  if (!found) {
    const list = (rootPy.length ? rootPy : pyFiles).slice(0, 5).join(', ');
    throw new UserError(`Entry point көрсетіңіз (мыс. main.py). ZIP ішіндегі .py файлдар: ${list}`);
  }
  if (!validEntry(found)) throw new UserError(`${found} атауы латын әріптерімен болуы керек`);
  return found;
}

// Windows файл атауына жарамды .exe аты (кеңейтусіз)
function exeBaseName(appName) {
  const n = appName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim();
  return !n || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n) ? 'app' : n;
}

// ---- иконка ----
// Басымдық: 1) ZIP ішіндегі icon.png / favicon.png  2) пайдаланушы жүктеген PNG  3) жоқ болса — қате
const ZIP_ICONS = ['icon.png', 'favicon.png'];
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngIcon(iconFile) {
  if (iconFile.size > MAX_ICON_BYTES) throw new UserError('Иконка тым үлкен (макс. 2 MB)');
  const data = fs.readFileSync(iconFile.path);
  if (!data.subarray(0, 8).equals(PNG_MAGIC)) throw new UserError('Иконка PNG форматында болуы керек');
  return data;
}

// ZIP-те иконка болмаса, жүктелген PNG-ні түбірге icon.png етіп қосады (жайылатын папка ескеріледі)
function applyIcon(zipPath, names, iconFile) {
  const inZip = ZIP_ICONS.find((n) => names.includes(n));
  if (inZip) return `Иконка: ZIP ішіндегі ${inZip}`;
  if (!iconFile) throw new UserError('Иконка жүктеңіз немесе ZIP ішіне icon.png қосыңыз');
  const zip = new AdmZip(zipPath);
  zip.addFile(names.stripped + 'icon.png', readPngIcon(iconFile));
  zip.writeZip(zipPath);
  return 'Иконка: жүктелген PNG (icon.png)';
}

// Android және Desktop үшін ортақ тексеру: package/App ID, түс, ZIP ішінде index.html, иконка
function prepareWebZip({ body, file, iconFile }) {
  const pkg = String(body.pkg || '').trim();
  if (!pkg) throw new UserError('Package ID жазыңыз (мыс. com.mysite.app)');
  const color = String(body.color || '#3DD4C8').trim();
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg)) {
    throw new UserError('Package ID форматы қате (мыс. com.mysite.app)');
  }
  if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
    throw new UserError('Түс форматы қате (мыс. #3DD4C8)');
  }
  const names = zipFileList(file.path);
  if (!names.includes('index.html')) {
    throw new UserError('ZIP ішінде index.html табылмады');
  }
  const iconNote = applyIcon(file.path, names, iconFile);
  return { pkg, color, iconNote };
}

// ---- платформалар ----
// prepare(): сұранысты тексеріп, runner-ге жіберілетін ZIP пен workflow параметрлерін қайтарады
const PLATFORMS = {
  android: {
    workflow: process.env.GITHUB_WORKFLOW_FILE || 'build-apk.yml',
    runTitle: 'APK build',
    jobSuffix: '',
    artifact: 'apk',
    ext: '.apk',
    stepHints: {
      ...COMMON_HINTS,
      'Параметрлерді тексеру': 'Параметрлер қате (package ID, түс немесе қосымша атауы)',
      'ZIP ашу (assets/www)': 'ZIP бұзық немесе ішінде index.html жоқ',
      'Иконканы қою': 'Иконка табылмады немесе PNG емес (icon.png / favicon.png)',
      'Параметрлерді жазу': 'Шаблонға параметрлерді жазу сәтсіз',
      'Gradle assembleRelease': 'Gradle build сәтсіз аяқталды',
      'APK-ны сақтау': 'APK файлы табылмады (build мәселесі)',
    },
    prepare({ body, file, iconFile, appName }) {
      const { pkg, color, iconNote } = prepareWebZip({ body, file, iconFile });
      return {
        zipPath: file.path,
        inputs: { app_name: appName, package: pkg, color },
        notes: [iconNote],
        fileName: null,                                // әдепкі: <app>-<jobId>.apk
      };
    },
  },

  python: {
    workflow: process.env.GITHUB_PYTHON_WORKFLOW_FILE || 'build-exe-python.yml',
    runTitle: 'EXE build',
    jobSuffix: '_py',
    artifact: 'exe',
    ext: '.exe',
    stepHints: {
      ...COMMON_HINTS,
      'Параметрлерді тексеру': 'Параметрлер қате (қосымша атауы немесе entry point)',
      'Python 3.11 орнату': 'Runner-де Python орнату сәтсіз (GitHub жағындағы уақытша қате болуы мүмкін)',
      'ZIP ашу': 'ZIP бұзық немесе ішінде entry point файлы жоқ',
      'Тәуелділіктерді орнату (requirements.txt)': 'requirements.txt ішіндегі пакеттерді орнату сәтсіз',
      'PyInstaller орнату': 'PyInstaller орнату сәтсіз',
      'PyInstaller --onefile': 'PyInstaller build сәтсіз аяқталды',
      'EXE-ні сақтау': '.exe файлы табылмады (build мәселесі)',
    },
    prepare({ body, file, appName }) {
      const exeName = exeBaseName(appName);
      let zipPath = file.path;
      let requested = String(body.entry || '').trim();

      // Жалғыз .py файл — өзіміз ZIP-ке орап жібереміз
      const name = path.basename(originalName(file));
      if (/\.py$/i.test(name)) {
        const inner = validEntry(name) ? name : 'main.py';
        const zip = new AdmZip();
        zip.addFile(inner, fs.readFileSync(file.path));
        zipPath = file.path + '.zip';
        zip.writeZip(zipPath);
        fs.rmSync(file.path, { force: true });
        requested = inner;
      }

      const entry = resolveEntryPoint(zipFileList(zipPath), requested);
      return {
        zipPath,
        inputs: { app_name: exeName, entry_point: entry },
        fileName: `${exeName}.exe`,
      };
    },
  },

  desktop: {
    workflow: process.env.GITHUB_DESKTOP_WORKFLOW_FILE || 'build-desktop-electron.yml',
    runTitle: 'Desktop build',
    jobSuffix: '_desk',
    artifact: 'desktop',
    ext: '.exe',
    stepHints: {
      ...COMMON_HINTS,
      'Параметрлерді тексеру': 'Параметрлер қате (App ID, түс немесе бағдарлама атауы)',
      'Node.js 22 орнату': 'Runner-де Node.js орнату сәтсіз (GitHub жағындағы уақытша қате болуы мүмкін)',
      'ZIP ашу (src)': 'ZIP бұзық немесе ішінде index.html жоқ',
      'Иконканы қою': 'Иконка табылмады немесе PNG емес (icon.png / favicon.png)',
      'Параметрлерді жазу': 'Шаблонға параметрлерді жазу сәтсіз',
      'Тәуелділіктерді орнату (npm ci)': 'Electron тәуелділіктерін орнату сәтсіз',
      'electron-builder --win': 'electron-builder build сәтсіз аяқталды',
      'EXE-ні сақтау': 'Setup .exe файлы табылмады (build мәселесі)',
    },
    prepare({ body, file, iconFile, appName }) {
      const { pkg, color, iconNote } = prepareWebZip({ body, file, iconFile });
      const exeName = exeBaseName(appName);                // .exe және орнату папкасының аты
      return {
        zipPath: file.path,
        inputs: { app_name: exeName, package: pkg, color },
        notes: [iconNote],
        fileName: `${exeName} Setup.exe`,
      };
    },
  },
};

// ---- жолдар ----
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');         // runner жүктеп алатын ZIP-тер
const OUTPUT_DIR = path.join(ROOT, 'output');          // дайын APK/EXE файлдар

for (const d of [UPLOAD_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.set('trust proxy', true);                          // Railway прокси артында https-ті дұрыс анықтау
app.use(cors());
app.use(express.static(path.join(ROOT, 'public')));    // дизайн осында

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: MAX_ZIP_BYTES } });

// ---- build жұмыстары (жадта) ----
// jobId -> { id, platform, status: 'running'|'done'|'error', log, error, download, size, fileName,
//            runId, runUrl, appName, zipPath, zipToken, dispatchedAt, finishedAt, outPath }
const jobs = new Map();
const zipTokens = new Map();                           // құпия ZIP токені -> jobId

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newJob(id, fields) {
  const job = {
    id, platform: 'android', status: 'running', log: [], error: null, download: null, size: null,
    fileName: null, runId: null, runUrl: null, appName: 'app', zipPath: null, zipToken: null,
    dispatchedAt: Date.now(), finishedAt: null, outPath: null, stepsSeen: new Set(),
    ...fields,
  };
  jobs.set(id, job);
  if (job.zipToken) zipTokens.set(job.zipToken, id);
  return job;
}

function addLog(job, m) {
  job.log.push(m);
  console.log(`[${job.id}] ${m}`);
}

function removeZip(job) {
  if (job.zipPath) fs.rmSync(job.zipPath, { force: true });
  if (job.zipToken) zipTokens.delete(job.zipToken);
  job.zipPath = null;
}

// ---- GitHub API көмекшілері ----
function gh(pathname, { method = 'GET', body, redirect = 'follow' } = {}) {
  return fetch(GH.api + pathname, {
    method,
    redirect,
    headers: {
      Authorization: `Bearer ${GH.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'apkforge-server',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function ghError(res) {
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch { /* JSON емес жауап */ }
  const err = new Error(`GitHub API ${res.status}${msg ? ': ' + msg : ''}`);
  err.status = res.status;
  return err;
}

async function ghJson(pathname) {
  const res = await gh(pathname);
  if (!res.ok) throw await ghError(res);
  return res.json();
}

function dispatchErrorMessage(e, workflow) {
  switch (e.status) {
    case 401: return 'GITHUB_TOKEN жарамсыз немесе мерзімі өткен';
    case 403: return 'GitHub токенінің рұқсаты жетпейді (Actions: Read and write керек) немесе API лимиті бітті';
    case 404: return `Репозиторий немесе ${workflow} workflow табылмады (токен рұқсатын және workflow ${GH.branch} branch-те бар екенін тексеріңіз)`;
    case 422: return 'GitHub workflow параметрлерді қабылдамады: ' + e.message;
    default: return e.status ? e.message : 'GitHub API-мен байланыс жоқ: ' + e.message;
  }
}

// Runner ZIP-ті осы URL арқылы жүктейді, сондықтан ол интернеттен қолжетімді болуы керек
function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `${req.protocol}://${req.get('host')}`;
}

// ---- негізгі build маршруты: GitHub Actions-ты іске қосып, дереу jobId қайтарады ----
const buildUpload = upload.fields([{ name: 'zip', maxCount: 1 }, { name: 'icon', maxCount: 1 }]);

app.post('/api/build', buildUpload, async (req, res) => {
  req.file = req.files && req.files.zip ? req.files.zip[0] : undefined;
  const iconFile = req.files && req.files.icon ? req.files.icon[0] : undefined;
  const removeIcon = () => { if (iconFile) fs.rmSync(iconFile.path, { force: true }); };
  const cleanup = () => {
    removeIcon();
    if (!req.file) return;
    fs.rmSync(req.file.path, { force: true });
    fs.rmSync(req.file.path + '.zip', { force: true });  // python: оралған .py
  };
  const fail = (code, error) => {
    cleanup();
    res.status(code).json({ ok: false, error });
  };

  // 1) параметрлер (тез тексерулер — build басталмай тұрып)
  const platformId = String(req.body.platform || 'android');
  const platform = Object.hasOwn(PLATFORMS, platformId) ? PLATFORMS[platformId] : null;
  if (!platform) return fail(400, `Белгісіз платформа: ${platformId}`);
  if (!ghConfigured()) {
    return fail(500, 'Сервер бапталмаған: GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME керек');
  }
  if (!req.file) return fail(400, platformId === 'python' ? '.py немесе ZIP файл жүктелмеді' : 'ZIP файл жүктелмеді');

  const appName = String(req.body.appName || '').trim().slice(0, 50);
  if (!appName) return fail(400, 'Қосымша атын жазыңыз');
  let prepared;
  try {
    prepared = platform.prepare({ body: req.body, file: req.file, iconFile, appName });
  } catch (e) {
    if (e instanceof UserError) return fail(400, e.message);
    console.error(e);
    return fail(500, 'Файлды өңдеу сәтсіз: ' + e.message);
  }
  removeIcon();                                        // иконка ZIP-ке қосылды (немесе керек емес)

  // 2) job жасау + ZIP-ке құпия URL
  const jobId = 'job_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex') + platform.jobSuffix;
  const zipToken = crypto.randomBytes(24).toString('hex');
  const job = newJob(jobId, {
    platform: platformId, appName, fileName: prepared.fileName, zipPath: prepared.zipPath, zipToken,
  });
  const zipUrl = `${publicBaseUrl(req)}/api/zip/${zipToken}`;
  if (/\/\/(localhost|127\.|\[::1\])/.test(zipUrl)) {
    addLog(job, '⚠ ZIP URL localhost — GitHub runner оған жете алмайды (PUBLIC_BASE_URL орнатыңыз)');
  }
  if (prepared.inputs.entry_point) addLog(job, `Entry point: ${prepared.inputs.entry_point}`);
  for (const note of prepared.notes || []) addLog(job, note);

  // 3) workflow_dispatch
  try {
    const r = await gh(`${repoPath()}/actions/workflows/${encodeURIComponent(platform.workflow)}/dispatches`, {
      method: 'POST',
      body: { ref: GH.branch, inputs: { job_id: jobId, zip_url: zipUrl, ...prepared.inputs } },
    });
    if (!r.ok) throw await ghError(r);
  } catch (e) {
    console.error(`[${jobId}] dispatch қатесі: ${e.message}`);
    removeZip(job);
    jobs.delete(jobId);
    return res.status(502).json({ ok: false, error: dispatchErrorMessage(e, platform.workflow) });
  }

  addLog(job, 'GitHub Actions-қа жіберілді, runner күтілуде...');
  monitor(job);
  res.json({ ok: true, jobId });
});

// ---- runner ZIP-ті осы жерден жүктейді ----
app.get('/api/zip/:token', (req, res) => {
  const job = jobs.get(zipTokens.get(req.params.token));
  if (!job || !job.zipPath || !fs.existsSync(job.zipPath)) return res.status(404).send('Табылмады');
  res.type('application/zip').sendFile(job.zipPath, (err) => {
    if (!err) addLog(job, 'Runner ZIP файлды жүктеп алды');
  });
});

// ---- build күйі ----
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId) || recoverJob(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'error', error: 'Job табылмады', log: [] });
  res.json({
    status: job.status,
    platform: job.platform,
    log: job.log,
    error: job.error,
    download: job.download,
    fileName: job.fileName,
    size: job.size,
    runUrl: job.runUrl,
  });
});

// Сервер қайта қосылса (мыс. Railway redeploy), жадтағы job-тар жоғалады.
// jobId run-name ішінде болғандықтан, run-ды GitHub-тан қайта тауып, бақылауды жалғастырамыз.
function recoverJob(jobId) {
  const m = /^job_(\d{13})_[0-9a-f]{6}(_py|_desk)?$/.exec(jobId);
  if (!m || !ghConfigured() || jobs.size > 500) return null;
  const dispatchedAt = Number(m[1]);
  if (Date.now() - dispatchedAt > BUILD_TIMEOUT_MS || dispatchedAt > Date.now()) return null;
  const platform = Object.keys(PLATFORMS).find((id) => PLATFORMS[id].jobSuffix === (m[2] || ''));
  const job = newJob(jobId, { dispatchedAt, platform });
  addLog(job, 'Сервер қайта қосылды — GitHub run ізделуде...');
  monitor(job);
  return job;
}

// ---- build бақылау (фонда) ----
async function findRun(job) {
  const platform = PLATFORMS[job.platform];
  const since = new Date(job.dispatchedAt - 60 * 1000).toISOString();
  const data = await ghJson(
    `${repoPath()}/actions/workflows/${encodeURIComponent(platform.workflow)}/runs` +
    `?event=workflow_dispatch&per_page=50&created=${encodeURIComponent('>=' + since)}`
  );
  const title = `${platform.runTitle} ${job.id}`;
  return (data.workflow_runs || []).find((r) => r.display_title === title) || null;
}

const RUN_STATUS_TEXT = {
  queued: 'Кезекте тұр (бос runner күтілуде)...',
  waiting: 'Кезекте тұр (бос runner күтілуде)...',
  pending: 'Кезекте тұр (бос runner күтілуде)...',
  requested: 'Кезекте тұр (бос runner күтілуде)...',
  in_progress: 'Build басталды (GitHub Actions runner)',
};

const SKIP_STEPS = /^(Set up job|Complete job|Post )/;

// Жаңадан басталған қадамдарды логқа шығарады, сәтсіз қадамның атын қайтарады
async function reportSteps(job) {
  const data = await ghJson(`${repoPath()}/actions/runs/${job.runId}/jobs`);
  let failed = null;
  for (const j of data.jobs || []) {
    for (const s of j.steps || []) {
      if (s.status === 'queued' || s.conclusion === 'skipped' || SKIP_STEPS.test(s.name)) continue;
      const key = `${j.id}:${s.number}`;
      if (!job.stepsSeen.has(key)) {
        job.stepsSeen.add(key);
        addLog(job, `▸ ${s.name}`);
      }
      if (s.conclusion === 'failure' && !failed) {
        failed = s.name;
        if (!job.stepsSeen.has(key + ':fail')) {
          job.stepsSeen.add(key + ':fail');
          addLog(job, `✗ ${s.name} — сәтсіз`);
        }
      }
    }
  }
  return failed;
}

// Artifact-ты (APK немесе EXE) жүктеп, output/ ішіне сақтайды
async function downloadArtifact(job) {
  const platform = PLATFORMS[job.platform];
  // Artifact run аяқталған соң бірнеше секундтан кейін пайда болуы мүмкін
  let art = null;
  for (let i = 0; i < 5 && !art; i++) {
    if (i) await sleep(POLL_MS);
    const data = await ghJson(`${repoPath()}/actions/runs/${job.runId}/artifacts?per_page=100`);
    art = (data.artifacts || []).find((a) => a.name === platform.artifact && !a.expired);
  }
  if (!art) throw new Error(`${platform.ext} artifact табылмады`);

  // GitHub қысқа мерзімді сілтемеге 302 қайтарады — оған Authorization жібермейміз
  let res = await gh(`${repoPath()}/actions/artifacts/${art.id}/zip`, { redirect: 'manual' });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    res = await fetch(res.headers.get('location'));
  }
  if (!res.ok) throw await ghError(res);

  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const entry = zip.getEntries().find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith(platform.ext));
  if (!entry) throw new Error(`Artifact ішінде ${platform.ext} файл жоқ`);

  const safeName = job.appName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'app';
  const outPath = path.join(OUTPUT_DIR, `${safeName}-${job.id}${platform.ext}`);
  fs.writeFileSync(outPath, entry.getData());
  return outPath;
}

async function monitor(job) {
  const add = (m) => addLog(job, m);
  const platform = PLATFORMS[job.platform];
  let apiFails = 0;
  // Уақытша желі/5xx қателерінде бірден тоқтамаймыз; 401/403/404 — бірден қате
  const tolerate = (e) => {
    if ([401, 403, 404].includes(e.status) || ++apiFails > 5) throw e;
    console.warn(`[${job.id}] GitHub API уақытша қатесі: ${e.message}`);
  };

  try {
    // 1) dispatch жасалған run-ды табу
    while (!job.runId) {
      try {
        const run = await findRun(job);
        apiFails = 0;
        if (run) {
          job.runId = run.id;
          job.runUrl = run.html_url;
          add(`GitHub Actions run: ${run.html_url}`);
          break;
        }
      } catch (e) { tolerate(e); }
      if (Date.now() - job.dispatchedAt > FIND_RUN_TIMEOUT_MS) {
        throw new Error('GitHub Actions run табылмады (workflow іске қосылмады)');
      }
      await sleep(POLL_MS);
    }

    // 2) run аяқталғанша күту
    let lastStatus = null;
    for (;;) {
      if (Date.now() - job.dispatchedAt > BUILD_TIMEOUT_MS) throw new Error('Build уақыт шегінен асты');
      try {
        const run = await ghJson(`${repoPath()}/actions/runs/${job.runId}`);
        if (run.status !== lastStatus) {
          lastStatus = run.status;
          if (RUN_STATUS_TEXT[run.status]) add(RUN_STATUS_TEXT[run.status]);
        }
        const started = run.status === 'in_progress' || run.status === 'completed';
        const failedStep = started ? await reportSteps(job) : null;
        apiFails = 0;

        if (run.status === 'completed') {
          if (run.conclusion === 'success') break;
          if (run.conclusion === 'cancelled') throw new Error('Build тоқтатылды');
          const hint = platform.stepHints[failedStep] ||
            `Build сәтсіз аяқталды (${failedStep || run.conclusion})`;
          const err = new Error(`${hint}. Толық лог: ${run.html_url}`);
          err.final = true;
          throw err;
        }
      } catch (e) {
        if (e.final) throw e;
        tolerate(e);
      }
      await sleep(POLL_MS);
    }

    // 3) дайын файлды жүктеп алу
    add(`${platform.ext.slice(1).toUpperCase()} жүктелуде (GitHub artifact)...`);
    job.outPath = await downloadArtifact(job);
    job.fileName = job.fileName || path.basename(job.outPath);
    job.download = `/api/download/${path.basename(job.outPath)}`;
    job.size = (fs.statSync(job.outPath).size / 1024 / 1024).toFixed(1) + ' MB';
    add('BUILD SUCCESSFUL');
    job.status = 'done';
  } catch (e) {
    job.error = e.message;
    job.status = 'error';
    console.error(`[${job.id}] ҚАТЕ: ${e.message}`);
  } finally {
    job.finishedAt = Date.now();
    removeZip(job);                                    // runner ZIP-ті алып болды
  }
}

// ---- ескі job, дайын файл және ZIP-терді тазалау ----
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      if (job.outPath) fs.rmSync(job.outPath, { force: true });
      removeZip(job);
      jobs.delete(id);
    }
  }
  // сервер қайта қосылғаннан кейін қалып қойған файлдар
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > 2 * JOB_TTL_MS) fs.rmSync(p, { force: true });
      } catch { /* файл әлдеқашан өшірілген */ }
    }
  }
}, 10 * 60 * 1000).unref();

// ---- дайын файлды жүктеу ----
app.get('/api/download/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(OUTPUT_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).send('Файл табылмады');
  // .exe пайдаланушы берген атпен жүктеледі (мыс. «Менің бағдарламам.exe»)
  const job = [...jobs.values()].find((j) => j.outPath === file);
  res.download(file, (job && job.fileName) || name);
});

// ---- multer және басқа қателер JSON түрінде ----
app.use((err, req, res, next) => {
  for (const f of Object.values(req.files || {}).flat()) fs.rmSync(f.path, { force: true });
  if (req.file) fs.rmSync(req.file.path, { force: true });
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ ok: false, error: `Файл тым үлкен (макс. ${MAX_ZIP_BYTES / 1024 / 1024} MB)` });
  }
  console.error(err);
  res.status(err instanceof multer.MulterError ? 400 : 500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n  APKForge сервері іске қосылды`);
  console.log(`  Браузерде аш: http://localhost:${PORT}`);
  if (ghConfigured()) {
    console.log(`  Build: GitHub Actions — ${GH.owner}/${GH.repo} @ ${GH.branch}`);
    for (const [id, p] of Object.entries(PLATFORMS)) console.log(`    ${id}: ${p.workflow}`);
    console.log('');
  } else {
    console.warn('  ⚠ GITHUB_TOKEN / GITHUB_REPO_OWNER / GITHUB_REPO_NAME орнатылмаған — build жұмыс істемейді\n');
  }
});
