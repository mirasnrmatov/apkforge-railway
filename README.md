# APKForge

Кодты жүктесеңіз, дайын бағдарлама жасап беретін веб-құрал:

| Платформа | Не жүктейсіз | Не аласыз | Workflow |
|---|---|---|---|
| **Android** | HTML/CSS/JS сайт ZIP-і (ішінде `index.html`) | `.apk` | `build-apk.yml` (Ubuntu, Gradle) |
| **Python** | Жалғыз `.py` файл немесе ZIP (`.py` файлдар + `requirements.txt`) | Windows `.exe` | `build-exe-python.yml` (Windows, PyInstaller) |

Интерфейстегі **Desktop** платформасы әзірге демо режимінде.

## Архитектура

Build Railway-де емес, **GitHub Actions**-та жүреді. Railway-дегі сервер тек жеңіл Node.js
қосымшасы, оған Java, Android SDK немесе Python керек емес. Gradle жадқа сыймай құлау мәселесі осылай шешілді.

```
Браузер ──файл──▶ Railway (server.js) ──workflow_dispatch──▶ GitHub Actions
   ▲                  │   ▲                                   (build-apk.yml / build-exe-python.yml)
   │   /api/status    │   └──── runner ZIP-ті /api/zip/<token> ────┘
   │   (3 сек polling)│         арқылы жүктеп алады
   │                  ▼
   └── /api/download ◀── сервер дайын APK/EXE artifact-ты GitHub-тан жүктеп алады
```

1. **`POST /api/build`** (`platform` = `android` | `python`): сервер файлды тексереді де,
   `uploads/` ішіне уақытша сақтайды. Android үшін `index.html`, package ID мен түс тексеріледі.
   Python үшін `.py` файлдар мен entry point тексеріледі. Жалғыз `.py` келсе, сервер оны өзі ZIP-ке орайды.
   Сервер ZIP-ке болжау мүмкін емес құпия сілтеме жасайды (`/api/zip/<48 таңбалы токен>`),
   сәйкес workflow-ды GitHub API арқылы іске қосады және бірден `{ jobId }` қайтарады.
2. **GitHub Actions** ZIP-ті жүктеп алады да, build жасайды:
   - **Android:** `template/` шаблонына салып, атауды, package ID мен түсті жазады, `./gradlew assembleRelease`
     жасайды, нәтижені `apk` деген artifact ретінде сақтайды.
   - **Python:** Python 3.11 орнатады, `requirements.txt` болса `pip install -r` жасайды, сосын
     `pyinstaller --onefile --name <атау> <entry point>` орындап, нәтижені `exe` деген artifact ретінде сақтайды.
   Artifact 1 күн сақталады.
3. Сервер фонда әр 6 секунд сайын run күйін сұрайды, қадамдарды логқа жазады. Run сәтті аяқталса,
   artifact-тан дайын файлды алып, `/api/download/...` сілтемесін береді.
4. **`GET /api/status/:jobId`**: `{ status: 'running'|'done'|'error', platform, log, error, download, fileName, size, runUrl }`
   қайтарады. Фронтенд оны әр 3 секунд сайын сұрайды.

> **jobId туралы.** GitHub-тың `workflow_dispatch` API-і run ID-ін қайтармайды. Сондықтан сервер
> өз `jobId`-ін жасап, оны run атауына қосады (`APK build <jobId>` немесе `EXE build <jobId>`),
> сосын run-ды осы атау бойынша табады. Python job-тарының ID-і `_py` деп аяқталады. Сервер қайта
> іске қосылса да (мысалы, Railway redeploy), `/api/status` run-ды GitHub-тан қайта тауып, бақылауды жалғастырады.

Бір build әдетте: **Android 3–6 минут**, **Python 2–5 минут** (тәуелділіктерге байланысты).
Бірінші Android build ұзағырақ жүреді, себебі Gradle кэші әлі жоқ.

## Python → .exe

- **Жалғыз `.py` файл:** сол файл entry point болады. Файл аты латын әрпімен болмаса
  (мыс. `сәлем.py`), ол `main.py` болып сақталады.
- **ZIP:** ішінде `.py` файлдар және қажет болса `requirements.txt`. ZIP ішінде бір ғана папка болса,
  ол жайылады. Сондықтан `proj/main.py` та, `main.py` та бірдей жұмыс істейді.
- **Entry point:** интерфейстегі «Негізгі скрипт» өрісі. Бос қалса, сервер `main.py`, `__main__.py`, `app.py`
  файлдарын іздейді. Олар жоқ болса, түбірдегі жалғыз `.py` файлды алады. Жол тек латын әріптерінен,
  сандардан және `_ . / -` таңбаларынан тұруы керек (мыс. `app/main.py`).
- **.exe атауы:** «Қосымша аты» өрісінен алынады, қазақша да болады (мыс. `Менің бағдарламам.exe`).
  Windows тыйым салған `< > : " / \ | ? *` таңбалары алынып тасталады.
- `.exe` консоль терезесімен ашылады (PyInstaller-дің әдепкі режимі).

---

## Баптау (бір рет қана жасалады)

### 1. Кодты GitHub-қа жүктеу

Workflow GitHub-тағы **`main`** branch-те болуы керек, әйтпесе API оны іске қоса алмайды.

> ⚠ `.github/workflows/` ішіндегі файлды push жасау үшін аккаунттың **`workflow`** рұқсаты
> болуы керек. GitHub Desktop мен браузер арқылы кіретін Git Credential Manager бұл рұқсатты
> өзі сұрайды. Егер push «refusing to allow ... without `workflow` scope» деп қабылданбаса,
> файлдарды GitHub сайтында қосыңыз: репозиторий → **Actions** → **set up a workflow yourself** →
> файл атын `build-apk.yml` (немесе `build-exe-python.yml`) қылып, мазмұнын қойыңыз.

### 2. GitHub Actions қосулы екенін тексеру

Репозиторий → **Settings** → **Actions** → **General** → *Actions permissions* бөлімінде
**Allow all actions and reusable workflows** таңдалған болуы керек. Workflow-лар тек GitHub-тың
ресми action-дарын қолданады: `actions/checkout`, `actions/setup-java`, `actions/setup-python`,
`actions/upload-artifact`.

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
| `GITHUB_WORKFLOW_FILE` | `build-apk.yml` | Android workflow файлының аты |
| `GITHUB_PYTHON_WORKFLOW_FILE` | `build-exe-python.yml` | Python workflow файлының аты |
| `PUBLIC_BASE_URL` | `https://$RAILWAY_PUBLIC_DOMAIN` | Runner ZIP-ті жүктейтін сервер адресі. Өз доменіңіз болса орнатыңыз, мыс. `https://apkforge.kz` |

Айнымалыларды сақтағаннан кейін Railway сервисті өзі қайта deploy жасайды.

### 5. Railway-де public домен бар екенін тексеру

GitHub runner ZIP-ті интернет арқылы жүктейді, сондықтан сервердің public адресі болуы керек:
сервис → **Settings** → **Networking** → **Public Networking**. Домен жоқ болса,
**Generate Domain** басыңыз. Railway `RAILWAY_PUBLIC_DOMAIN` айнымалысын өзі береді, сервер соны қолданады.

### 6. Тексеру

1. Railway → сервис → **Deployments** → **View logs** ашыңыз. Мына жол көрінуі керек:
   `Build: GitHub Actions — mirasnrmatov/apkforge-railway @ main`, оның астында
   `android: build-apk.yml` және `python: build-exe-python.yml`.
   Оның орнына `⚠ GITHUB_TOKEN ... орнатылмаған` шықса, 4-қадамды тексеріңіз.
2. Сайтты ашып, Android таңдап, `index.html` бар ZIP жүктеп, **APK құрастыру** басыңыз.
3. Python таңдап, `print("Сәлем")` деген жалғыз `.py` файл жүктеп, **.exe құрастыру** басыңыз.
4. Консольде `GitHub Actions run: https://github.com/...` сілтемесі шығады. Build-ті GitHub-тағы
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
| `Entry point көрсетіңіз ...` | ZIP-те `main.py` жоқ және бірнеше `.py` бар. «Негізгі скрипт» өрісіне жазыңыз |
| `requirements.txt ішіндегі пакеттерді орнату сәтсіз` | Пакет аты/нұсқасы қате немесе Windows-та орнатылмайды. Толық лог GitHub сілтемесінде |
| `PyInstaller build сәтсіз аяқталды` | Скриптте синтаксис қатесі немесе PyInstaller қолдамайтын пакет. Толық лог GitHub сілтемесінде |

## Шектеулер

- **GitHub Actions минуттары:** жабық репозиторийде Free тарифте айына 2000 минут бар.
  Бір Android build шамамен 3–6 минут. **Windows runner минуттары 2 есе есептеледі**,
  яғни 3 минуттық Python build 6 минут болып саналады.
- **Python build қауіпсіздігі:** `requirements.txt` ішіндегі пакеттер runner-де орнатылады,
  яғни бөтен код орындалады. Сондықтан Python workflow-ның job токенінде ешқандай рұқсат жоқ
  (`permissions: {}`), репозиторий checkout жасалмайды, secret-тер берілмейді. Runner build
  біткен соң жойылады. Ең нашар жағдайда тек Actions минуттары жұмсалады (шегі — 30 минут).
- **API лимиті:** token-ға сағатына 5000 сұрау. Бір белсенді build минутына ~20 сұрау жасайды,
  сондықтан бір уақытта бірнеше build жүре алады.
- **Сақтау мерзімі:** дайын APK/EXE серверде 1 сағат, GitHub artifact 1 күн сақталады.
  Railway контейнерінің диск кеңістігі тұрақты емес, redeploy кезінде дайын файлдар өшеді.
- **Файл өлшемі:** ең көбі 100 MB.
- **Құпиялылық:** workflow параметрлері (ZIP сілтемесі, қосымша атауы, entry point) Actions бетінде көрінеді.
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
| `server.js` | Express сервері: файл қабылдау, workflow іске қосу, күйді бақылау, APK/EXE беру |
| `public/index.html` | Веб-интерфейс |
| `.github/workflows/build-apk.yml` | APK құрастыратын GitHub Actions workflow |
| `.github/workflows/build-exe-python.yml` | Python-нан Windows .exe құрастыратын workflow |
| `template/` | Android WebView шаблоны (`__APP_NAME__`, `__APPLICATION_ID__`, `__THEME_COLOR__` токендері) |
| `Dockerfile` | Railway үшін жеңіл Node.js контейнері |
