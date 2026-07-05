const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const productName = 'Local Diary';
const userApplications = path.join(os.homedir(), 'Applications');
const systemApplications = '/Applications';
const projectAlias = path.join(root, `${productName}.app`);
const sourceIcon = path.join(root, 'icon.png');
const buildDir = path.join(root, 'build');
const iconsetDir = path.join(buildDir, 'icon.iconset');
const macIcon = path.join(buildDir, 'icon.icns');

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options
  });
}

function ensureDependencies() {
  if (!fs.existsSync(path.join(root, 'node_modules', 'electron-builder'))) {
    run('npm', ['install']);
  }
}

function ensureMacIcon() {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(sourceIcon)) {
    throw new Error(`没有找到 app icon：${sourceIcon}`);
  }
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const icons = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];
  for (const [name, size] of icons) {
    run('/usr/bin/sips', ['-z', String(size), String(size), sourceIcon, '--out', path.join(iconsetDir, name)]);
  }
  fs.rmSync(macIcon, { force: true });
  run('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', macIcon]);
  fs.rmSync(iconsetDir, { recursive: true, force: true });
}

function copyDir(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (process.platform === 'darwin') {
    run('/usr/bin/ditto', [source, target]);
    return;
  }
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
}

function candidateApps() {
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) return [];
  const apps = [];
  const stack = [dist];
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const fullPath = path.join(current, name);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory() && name.endsWith('.app')) {
        apps.push(fullPath);
      } else if (stat.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return apps;
}

ensureDependencies();
ensureMacIcon();
run('npx', ['electron-builder', '--mac', 'dir', '--publish', 'never']);

const apps = candidateApps().filter((appPath) => path.basename(appPath) === `${productName}.app`);
if (!apps.length) {
  throw new Error('打包完成但没有找到 Local Diary.app');
}

const builtApp = apps[0];
const installedApp = path.join(userApplications, `${productName}.app`);
copyDir(builtApp, installedApp);

let systemApp = '';
try {
  systemApp = path.join(systemApplications, `${productName}.app`);
  copyDir(builtApp, systemApp);
} catch (error) {
  systemApp = '';
  console.warn(`没有安装到 /Applications：${error.message}`);
}

try {
  fs.rmSync(projectAlias, { recursive: true, force: true });
  fs.symlinkSync(installedApp, projectAlias, 'dir');
} catch (error) {
  console.warn(`没有创建项目内快捷入口：${error.message}`);
}

console.log('');
console.log(`已生成：${builtApp}`);
console.log(`已安装：${installedApp}`);
if (systemApp) console.log(`已安装：${systemApp}`);
console.log(`项目内入口：${projectAlias}`);
console.log('现在可以在 Finder 里双击打开。');
