// APKForge — Electron қабығы: пайдаланушының HTML/CSS/JS коды src/ ішінде.
const { app, BrowserWindow, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

// Терезе иконкасы: ZIP ішінде icon.png / favicon.png болса, соны қолданамыз
const ICON = ['icon.png', 'favicon.png']
  .map((f) => path.join(__dirname, 'src', f))
  .find((f) => fs.existsSync(f));

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    show: false,
    title: pkg.productName,
    backgroundColor: (pkg.apkforge && pkg.apkforge.themeColor) || '#FFFFFF',
    ...(ICON ? { icon: ICON } : {}),
    webPreferences: {
      // Пайдаланушы коды Node API-ға қол жеткізбейді — кәдімгі браузердегідей жұмыс істейді
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Сыртқы сілтемелер (http/https) жүйелік браузерде ашылады
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// Мәзір жолағын толық алып тастау
Menu.setApplicationMenu(null);

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
