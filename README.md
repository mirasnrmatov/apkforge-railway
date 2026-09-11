# APKForge

HTML/CSS/JS сайтты ZIP қылып жүктесеңіз, Android APK жасап беретін веб-құрал.

## Архитектура

APK Railway-де емес, **GitHub Actions**-та құрастырылады. Railway-дегі сервер тек жеңіл Node.js
қосымшасы, оған Java мен Android SDK керек емес. Gradle жадқа сыймай құлау мәселесі осылай шешілді.

```
Браузер ──ZIP──▶ Railway (server.js) ──workflow_dispatch──▶ GitHub Actions (build-apk.yml)
   ▲                  │   ▲                                        │
   │   /api/status    │   └──── runner ZIP-ті /api/zip/<token> ────┘
   │   (3 сек polling)│         арқылы жүктеп алады
   │                  ▼
   └── /api/download ◀── сервер дайын APK artifact-ты GitHub-тан жүктеп алады
```

1. **`POST /api/build`**: сервер ZIP-ті тексереді (index.html бар ма, package ID, түс) де,
   `uploads/` ішіне уақытша сақтайды. ZIP-ке болжау мүмкін емес құпия сілтеме жасайды
   (`/api/zip/<48 таңбалы токен>`), GitHub API арқылы `build-apk.yml` workflow-ды іске қосады
   және бірден `{ jobId }` қайтарады.
2. **GitHub Actions** ZIP-ті жүктеп алады, `template/` шаблонына салады, атауды, package ID мен
   түсті жазады, `./gradlew assembleRelease` жасайды және APK-ны `apk` деген artifact ретінде сақтайды
   (1 күн сақталады).
3. Сервер фонда әр 6 секунд сайын run күйін сұрайды, қадамдарды логқа жазады. Run сәтті аяқталса,
   artifact-тан APK-ны алып, `/api/download/...` сілтемесін береді.
4. **`GET /api/status/:jobId`**: `{ status: 'running'|'done'|'error', log, error, download, size, runUrl }`
   қайтарады. Фронтенд оны әр 3 секунд сайын сұрайды.

> **jobId туралы.** GitHub-тың `workflow_dispatch` API-і run ID-ін қайтармайды. Сондықтан сервер
> өз `jobId`-ін жасап, оны run атауына (`run-name: APK build <jobId>`) қосады, сосын run-ды осы
> атау бойынша табады. Сервер қайта іске қосылса да (мысалы, Railway redeploy), `/api/status`
> run-ды GitHub-тан қайта тауып, бақылауды жалғастырады.

Бір build әдетте **3–6 минут** алады. Бірінші build ұзағырақ жүреді, себебі Gradle кэші әлі жоқ.

---

## Баптау (бір рет қана жасалады)

### 1. Кодты GitHub-қа жүктеу

Workflow GitHub-тағы **`main`** branch-те болуы керек, әйтпесе API оны іске қоса алмайды.

> ⚠ `.github/workflows/` ішіндегі файлды push жасау үшін аккаунттың **`workflow`** рұқсаты
> болуы керек. GitHub Desktop мен браузер арқылы кіретін Git Credential Manager бұл рұқсатты
> өзі сұрайды. Егер push «refusing to allow ... without `workflow` scope» деп қабылданбаса,
> файлды GitHub сайтында қосыңыз: репозиторий → **Actions** → **set up a workflow yourself** →
> файл атын `build-apk.yml` қылып, мазмұнын қойыңыз.

### 2. GitHub Actions қосулы екенін тексеру

Репозиторий → **Settings** → **Actions** → **General** → *Actions permissions* бөлімінде
**Allow all actions and reusable workflows** таңдалған болуы керек. Workflow тек GitHub-тың
ресми action-дарын қолданады: `actions/checkout`, `actions/setup-java`, `actions/upload-artifact`.

### 3. GitHub Personal Access Token жасау

Fine-grained token ұсынылады: оның рұқсаты тек осы бір репозиториймен шектеледі.

1. GitHub-та оң жақ жоғарыдағы аватарды басып, **Settings** ашыңыз.
2. Сол жақ мәзірдің ең астынан **Developer settings** таңдаңыз.
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
4. Толтырыңыз:
   - **Token name:** `apkforge-railway`
   - **Expiration:** мысалы 90 күн. Мерзімі біткенде жаңа token жасап, Railway-де ауыстыру керек.
   - **Resource owner:** `mirasnrmatov`
   - **Repository access:** **Only select repositories** → `apkforge-railway`
   - **Permissions** → **Repository permissions**:
     - **Actions:** `Read and write` (workflow іске қосу үшін write, artifact жүктеу үшін read)
     - **Metadata:** `Read-only` (өзі қосылады)
5. **Generate token** басып, `github_pat_...` деп басталатын token-ды көшіріп алыңыз.
   **Ол тек бір рет көрсетіледі.**

<details>
<summary>Балама: classic token</summary>

**Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**.
Жабық репозиторий үшін **`repo`** scope-ын белгілеңіз. Бұл token-ның сіздің **барлық**
репозиторийлеріңізге қолжетімділігі болады, сондықтан fine-grained нұсқасы қауіпсізірек.
</details>

> Token-ды кодқа, README-ге немесе чатқа ешқашан жазбаңыз. Ол тек Railway Variables ішінде тұруы керек.

### 4. Railway-ге айнымалыларды қосу

Railway → жоба → сервис → **Variables** → **New Variable** (немесе **Raw Editor**):

```
GITHUB_TOKEN=github_pat_...            ← 3-қадамдағы token
GITHUB_REPO_OWNER=mirasnrmatov
GITHUB_REPO_NAME=apkforge-railway
```

Қосымша айнымалылар (әдетте керек емес):

| Айнымалы | Әдепкі мән | Не үшін |
|---|---|---|
| `GITHUB_BRANCH` | `main` | Workflow қай branch-тен іске қосылады |
| `GITHUB_WORKFLOW_FILE` | `build-apk.yml` | Workflow файлының аты |
| `PUBLIC_BASE_URL` | `https://$RAILWAY_PUBLIC_DOMAIN` | Runner ZIP-ті жүктейтін сервер адресі. Өз доменіңіз болса орнатыңыз, мыс. `https://apkforge.kz` |

Айнымалыларды сақтағаннан кейін Railway сервисті өзі қайта deploy жасайды.

### 5. Railway-де public домен бар екенін тексеру

GitHub runner ZIP-ті интернет арқылы жүктейді, сондықтан сервердің public адресі болуы керек:
сервис → **Settings** → **Networking** → **Public Networking**. Домен жоқ болса,
**Generate Domain** басыңыз. Railway `RAILWAY_PUBLIC_DOMAIN` айнымалысын өзі береді, сервер соны қолданады.

### 6. Тексеру

1. Railway → сервис → **Deployments** → **View logs** ашыңыз. Мына жол көрінуі керек:
   `Build: GitHub Actions — mirasnrmatov/apkforge-railway (build-apk.yml @ main)`.
   Оның орнына `⚠ GITHUB_TOKEN ... орнатылмаған` шықса, 4-қадамды тексеріңіз.
2. Сайтты ашып, `index.html` бар ZIP жүктеп, **APK құрастыру** басыңыз.
3. Консольде `GitHub Actions run: https://github.com/...` сілтемесі шығады. Build-ті GitHub-тағы
   **Actions** бетінен де көруге болады.

---

## Қателер және шешімдері

| Хабар | Себебі / шешімі |
|---|---|
| `Сервер бапталмаған: GITHUB_TOKEN ...` | Railway Variables толық емес (4-қадам) |
| `GITHUB_TOKEN жарамсыз немесе мерзімі өткен` | Жаңа token жасап, Railway-де ауыстырыңыз |
| `GitHub токенінің рұқсаты жетпейді` | Token-ға **Actions: Read and write** рұқсаты керек |
| `Репозиторий немесе build-apk.yml workflow табылмады` | Token осы репозиторийге берілмеген немесе workflow `main`-да жоқ |
| `GitHub Actions run табылмады` | Actions өшірулі (2-қадам) немесе GitHub Actions уақытша істемей тұр |
| `Runner ZIP файлды жүктей алмады` | Railway public домені жоқ (5-қадам) немесе `PUBLIC_BASE_URL` қате |
| `Gradle build сәтсіз аяқталды` | Қатенің толық логы көрсетілген GitHub сілтемесінде |

## Шектеулер

- **GitHub Actions минуттары:** жабық репозиторийде Free тарифте айына 2000 минут бар.
  Бір build шамамен 3–6 минут, яғни айына ~300–600 build.
- **API лимиті:** token-ға сағатына 5000 сұрау. Бір белсенді build минутына ~20 сұрау жасайды,
  сондықтан бір уақытта бірнеше build жүре алады.
- **Сақтау мерзімі:** дайын APK серверде 1 сағат, GitHub artifact 1 күн сақталады.
  Railway контейнерінің диск кеңістігі тұрақты емес, redeploy кезінде APK-лар өшеді.
- **ZIP өлшемі:** ең көбі 100 MB.
- **Құпиялылық:** workflow параметрлері (ZIP сілтемесі, қосымша атауы) Actions бетінде көрінеді.
  Сондықтан репозиторий **жабық (private)** болуы керек. ZIP сілтемесі build аяқталғанша ғана жұмыс істейді.

## Жергілікті іске қосу

```bash
npm install
GITHUB_TOKEN=github_pat_... GITHUB_REPO_OWNER=mirasnrmatov GITHUB_REPO_NAME=apkforge-railway node server.js
```

GitHub runner `localhost`-қа жете алмайды. Жергілікті тексеру үшін серверді туннель арқылы
(мысалы, `cloudflared tunnel --url http://localhost:3000`) интернетке шығарып, оның адресін
`PUBLIC_BASE_URL` айнымалысына жазыңыз.

## Файлдар

| Файл | Мақсаты |
|---|---|
| `server.js` | Express сервері: ZIP қабылдау, workflow іске қосу, күйді бақылау, APK беру |
| `public/index.html` | Веб-интерфейс |
| `.github/workflows/build-apk.yml` | APK құрастыратын GitHub Actions workflow |
| `template/` | Android WebView шаблоны (`__APP_NAME__`, `__APPLICATION_ID__`, `__THEME_COLOR__` токендері) |
| `Dockerfile` | Railway үшін жеңіл Node.js контейнері |
