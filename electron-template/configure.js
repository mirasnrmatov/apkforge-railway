// package.json ішіндегі токендерді env мәндерімен алмастырады:
//   APP_NAME, APP_ID, THEME_COLOR, APP_VERSION (әдепкі 1.0.0)
// Workflow-да (және локальды тестте) `node configure.js` арқылы шақырылады.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'package.json');
const fail = (m) => { console.log(`::error::${m}`); process.exit(1); };

const appName = (process.env.APP_NAME || '').trim();
const values = {
  __APP_NAME__: appName,
  __APP_ID__: (process.env.APP_ID || '').trim(),
  __VERSION__: (process.env.APP_VERSION || '1.0.0').trim(),
  __DESCRIPTION__: `${appName} — APKForge desktop app`,
  __THEME_COLOR__: (process.env.THEME_COLOR || '#3DD4C8').trim(),
};
if (!appName) fail('APP_NAME бос');
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(values.__APP_ID__)) fail('App ID форматы қате (мыс. com.mysite.app)');
if (!/^\d+\.\d+\.\d+$/.test(values.__VERSION__)) fail('Нұсқа форматы қате (мыс. 1.0.0)');
if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(values.__THEME_COLOR__)) fail('Түс форматы қате (мыс. #3DD4C8)');

let txt = fs.readFileSync(file, 'utf8');
for (const [token, value] of Object.entries(values)) {
  if (!txt.includes(token)) fail(`${token} табылмады: package.json`);
  // JSON жол ішіне қауіпсіз қою (тырнақша, backslash т.б.)
  txt = txt.split(token).join(JSON.stringify(value).slice(1, -1));
}
const pkg = JSON.parse(txt);                          // нәтиже жарамды JSON екенін тексеру
fs.writeFileSync(file, txt);
console.log(`productName: ${pkg.productName}\nappId: ${pkg.build.appId}\nversion: ${pkg.version}\nthemeColor: ${pkg.apkforge.themeColor}`);
