// APKForge сервері.
// Build Railway-де емес, GitHub Actions runner-де жүреді (.github/workflows/build-apk.yml):
//   1) /api/build ZIP-ті уақытша сақтап, оған құпия URL жасайды да, workflow_dispatch жібереді
//   2) сервер фонда run күйін бақылайды (run-name ішінде jobId бар)
//   3) run сәтті аяқталса, APK artifact-ты жүктеп, /api/download арқылы береді

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
  workflow: process.env.GITHUB_WORKFLOW_FILE || 'build-apk.yml',
  branch: process.env.GITHUB_BRANCH || 'main',
  api: (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
};
const ARTIFACT_NAME = 'apk';                       // workflow-дағы upload-artifact name
const ghConfigured = () => Boolean(GH.token && GH.owner && GH.repo);
const repoPath = () => `/repos/${encodeURIComponent(GH.owner)}/${encodeURIComponent(GH.repo)}`;

// ---- уақыт шектері ----
const POLL_MS = 6000;                              // GitHub API-ды қаншалықты жиі сұрау
const FIND_RUN_TIMEOUT_MS = 3 * 60 * 1000;         // dispatch-тан кейін run пайда болуы керек уақыт
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;           // бүкіл build үшін шек
const JOB_TTL_MS = 60 * 60 * 1000;                 // аяқталған job пен APK 1 сағат сақталады
const MAX_ZIP_BYTES = 100 * 1024 * 1024;

// Workflow қадамы сәтсіз болса, пайдаланушыға көрсетілетін түсінікті хабар
const STEP_HINTS = {
  'Параметрлерді тексеру': 'Параметрлер қате (package ID, түс немесе қосымша атауы)',
  'ZIP жүктеу': 'Runner ZIP файлды жүктей алмады (сервердің public домені қолжетімді ме?)',
  'ZIP ашу (assets/www)': 'ZIP бұзық немесе ішінде index.html жоқ',
  'Параметрлерді жазу': 'Шаблонға параметрлерді жазу сәтсіз',
  'Gradle assembleRelease': 'Gradle build сәтсіз аяқталды',
  'APK-ны сақтау': 'APK файлы табылмады (build мәселесі)',
};

// ---- жолдар ----
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');         // runner жүктеп алатын ZIP-тер
const OUTPUT_DIR = path.join(ROOT, 'output');          // дайын APK-лар

for (const d of [UPLOAD_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.set('trust proxy', true);                          // Railway прокси артында https-ті дұрыс анықтау
app.use(cors());
app.use(express.static(path.join(ROOT, 'public')));    // дизайн осында

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: MAX_ZIP_BYTES } });

// ---- build жұмыстары (жадта) ----
// jobId -> { id, status: 'running'|'done'|'error', log, error, download, size,
//            runId, runUrl, appName, zipPath, zipToken, dispatchedAt, finishedAt, apkPath }
const jobs = new Map();
const zipTokens = new Map();                           // құпия ZIP токені -> jobId

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newJob(id, fields) {
  const job = {
    id, status: 'running', log: [], error: null, download: null, size: null,
    runId: null, runUrl: null, appName: 'app', zipPath: null, zipToken: null,
    dispatchedAt: Date.now(), finishedAt: null, apkPath: null, stepsSeen: new Set(),
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

function dispatchErrorMessage(e) {
  switch (e.status) {
    case 401: return 'GITHUB_TOKEN жарамсыз немесе мерзімі өткен';
    case 403: return 'GitHub токенінің рұқсаты жетпейді (Actions: Read and write керек) немесе API лимиті бітті';
    case 404: return `Репозиторий немесе ${GH.workflow} workflow табылмады (токен рұқсатын және workflow ${GH.branch} branch-те бар екенін тексеріңіз)`;
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

// ZIP ішінде index.html түбірде немесе жалғыз папканың ішінде бар ма (workflow-мен бірдей ереже)
function zipHasIndexHtml(file) {
  const names = new AdmZip(file).getEntries()
    .map((e) => e.entryName.replace(/\\/g, '/'))
    .filter((n) => !n.startsWith('__MACOSX/') && n !== '.DS_Store');
  if (names.includes('index.html')) return true;
  const tops = new Set(names.map((n) => n.split('/')[0]));
  return tops.size === 1 && names.includes(`${[...tops][0]}/index.html`);
}

// ---- негізгі build маршруты: GitHub Actions-ты іске қосып, дереу jobId қайтарады ----
app.post('/api/build', upload.single('zip'), async (req, res) => {
  const fail = (code, error) => {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    res.status(code).json({ ok: false, error });
  };

  // 1) параметрлер (тез тексерулер — build басталмай тұрып)
  const appName = String(req.body.appName || 'MyApp').trim().slice(0, 50) || 'MyApp';
  const pkg = String(req.body.pkg || 'com.apkforge.app').trim();
  const color = String(req.body.color || '#3DD4C8').trim();

  if (!ghConfigured()) {
    return fail(500, 'Сервер бапталмаған: GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME керек');
  }
  if (!req.file) return fail(400, 'ZIP файл жүктелмеді');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg)) {
    return fail(400, 'Package ID форматы қате (мыс. com.mysite.app)');
  }
  if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
    return fail(400, 'Түс форматы қате (мыс. #3DD4C8)');
  }
  try {
    if (!zipHasIndexHtml(req.file.path)) return fail(400, 'ZIP ішінде index.html табылмады');
  } catch {
    return fail(400, 'Жүктелген файл ZIP емес немесе бұзық');
  }

  // 2) job жасау + ZIP-ке құпия URL
  const jobId = 'job_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  const zipToken = crypto.randomBytes(24).toString('hex');
  const job = newJob(jobId, { appName, zipPath: req.file.path, zipToken });
  const zipUrl = `${publicBaseUrl(req)}/api/zip/${zipToken}`;
  if (/\/\/(localhost|127\.|\[::1\])/.test(zipUrl)) {
    addLog(job, '⚠ ZIP URL localhost — GitHub runner оған жете алмайды (PUBLIC_BASE_URL орнатыңыз)');
  }

  // 3) workflow_dispatch
  try {
    const r = await gh(`${repoPath()}/actions/workflows/${encodeURIComponent(GH.workflow)}/dispatches`, {
      method: 'POST',
      body: {
        ref: GH.branch,
        inputs: { job_id: jobId, zip_url: zipUrl, app_name: appName, package: pkg, color },
      },
    });
    if (!r.ok) throw await ghError(r);
  } catch (e) {
    console.error(`[${jobId}] dispatch қатесі: ${e.message}`);
    removeZip(job);
    jobs.delete(jobId);
    return res.status(502).json({ ok: false, error: dispatchErrorMessage(e) });
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
    log: job.log,
    error: job.error,
    download: job.download,
    size: job.size,
    runUrl: job.runUrl,
  });
});

// Сервер қайта қосылса (мыс. Railway redeploy), жадтағы job-тар жоғалады.
// jobId run-name ішінде болғандықтан, run-ды GitHub-тан қайта тауып, бақылауды жалғастырамыз.
function recoverJob(jobId) {
  const m = /^job_(\d{13})_[0-9a-f]{6}$/.exec(jobId);
  if (!m || !ghConfigured() || jobs.size > 500) return null;
  const dispatchedAt = Number(m[1]);
  if (Date.now() - dispatchedAt > BUILD_TIMEOUT_MS || dispatchedAt > Date.now()) return null;
  const job = newJob(jobId, { dispatchedAt });
  addLog(job, 'Сервер қайта қосылды — GitHub run ізделуде...');
  monitor(job);
  return job;
}

// ---- build бақылау (фонда) ----
async function findRun(job) {
  const since = new Date(job.dispatchedAt - 60 * 1000).toISOString();
  const data = await ghJson(
    `${repoPath()}/actions/workflows/${encodeURIComponent(GH.workflow)}/runs` +
    `?event=workflow_dispatch&per_page=50&created=${encodeURIComponent('>=' + since)}`
  );
  const title = `APK build ${job.id}`;
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

async function downloadApk(job) {
  // Artifact run аяқталған соң бірнеше секундтан кейін пайда болуы мүмкін
  let art = null;
  for (let i = 0; i < 5 && !art; i++) {
    if (i) await sleep(POLL_MS);
    const data = await ghJson(`${repoPath()}/actions/runs/${job.runId}/artifacts?per_page=100`);
    art = (data.artifacts || []).find((a) => a.name === ARTIFACT_NAME && !a.expired);
  }
  if (!art) throw new Error('APK artifact табылмады');

  // GitHub қысқа мерзімді сілтемеге 302 қайтарады — оған Authorization жібермейміз
  let res = await gh(`${repoPath()}/actions/artifacts/${art.id}/zip`, { redirect: 'manual' });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    res = await fetch(res.headers.get('location'));
  }
  if (!res.ok) throw await ghError(res);

  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const entry = zip.getEntries().find((e) => !e.isDirectory && e.entryName.endsWith('.apk'));
  if (!entry) throw new Error('Artifact ішінде APK жоқ');

  const safeName = job.appName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'app';
  const apkPath = path.join(OUTPUT_DIR, `${safeName}-${job.id}.apk`);
  fs.writeFileSync(apkPath, entry.getData());
  return apkPath;
}

async function monitor(job) {
  const add = (m) => addLog(job, m);
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
          const hint = STEP_HINTS[failedStep] || `Build сәтсіз аяқталды (${failedStep || run.conclusion})`;
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

    // 3) APK-ны жүктеп алу
    add('APK жүктелуде (GitHub artifact)...');
    job.apkPath = await downloadApk(job);
    job.download = `/api/download/${path.basename(job.apkPath)}`;
    job.size = (fs.statSync(job.apkPath).size / 1024 / 1024).toFixed(1) + ' MB';
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

// ---- ескі job, APK және ZIP файлдарын тазалау ----
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      if (job.apkPath) fs.rmSync(job.apkPath, { force: true });
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

// ---- APK жүктеу ----
app.get('/api/download/:name', (req, res) => {
  const file = path.join(OUTPUT_DIR, path.basename(req.params.name));
  if (fs.existsSync(file)) res.download(file);
  else res.status(404).send('Файл табылмады');
});

// ---- multer және басқа қателер JSON түрінде ----
app.use((err, req, res, next) => {
  if (req.file) fs.rmSync(req.file.path, { force: true });
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ ok: false, error: `ZIP файл тым үлкен (макс. ${MAX_ZIP_BYTES / 1024 / 1024} MB)` });
  }
  console.error(err);
  res.status(err instanceof multer.MulterError ? 400 : 500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n  APKForge сервері іске қосылды`);
  console.log(`  Браузерде аш: http://localhost:${PORT}`);
  if (ghConfigured()) {
    console.log(`  Build: GitHub Actions — ${GH.owner}/${GH.repo} (${GH.workflow} @ ${GH.branch})\n`);
  } else {
    console.warn('  ⚠ GITHUB_TOKEN / GITHUB_REPO_OWNER / GITHUB_REPO_NAME орнатылмаған — build жұмыс істемейді\n');
  }
});
