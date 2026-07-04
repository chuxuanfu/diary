const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFile, execFileSync, spawn } = require('node:child_process');
const pkg = require('../package.json');

let mainWindow;
let db;
let currentDataDir;
let diaryWatcher;
let diaryWatchTimers = new Map();

const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Documents', 'DiaryVault');
const DEFAULT_WHISPER_MODEL = path.join(os.homedir(), '.local', 'share', 'diary', 'models', 'ggml-base.bin');
const DEFAULT_STYLE_PROMPT = [
  '你是一位中文日记整理助手。',
  '把零散材料整理成当天日记。不要官话套话，不要总结腔，不要复杂长句。',
  '语气自然，像一个人认真回想今天发生了什么。',
  '把口语内容改成稍微书面一点，但保留原本的真实感。',
  '可以写一点感受，但不要拔高，不要说教。',
  '图片如果和内容有关，请把给定的 Markdown 图片语法放到合适的位置，并在图片前后写一两句简单说明。'
].join('\n');
const DEFAULT_SETTINGS = {
  aiProvider: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  openaiApiKey: '',
  textModel: 'qwen3.6:35b-mlx',
  visionModel: 'qwen3-vl:8b',
  whisperCommand: 'auto',
  whisperModelPath: DEFAULT_WHISPER_MODEL,
  stylePrompt: DEFAULT_STYLE_PROMPT
};
const COMMAND_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin'
];

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

async function readAppConfig() {
  try {
    return JSON.parse(await fsp.readFile(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeAppConfig(config) {
  await fsp.mkdir(path.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function sqlQuote(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 64, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runSqlite(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', [dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `sqlite3 exited with ${code}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(sql);
  });
}

class DiaryDb {
  constructor(dbPath) {
    this.dbPath = dbPath;
  }

  async init() {
    await runSqlite(this.dbPath, `
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        date TEXT PRIMARY KEY,
        draft_text TEXT NOT NULL DEFAULT '',
        diary_text TEXT NOT NULL DEFAULT '',
        diary_path TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        original_path TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        extracted_text TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await this.ensureSetting(key, value);
    }
    await this.repairEmptyDefaults();
  }

  async run(sql) {
    return runSqlite(this.dbPath, sql);
  }

  async all(sql) {
    const { stdout } = await runCommand('sqlite3', ['-json', this.dbPath, sql]);
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : [];
  }

  async get(sql) {
    const rows = await this.all(sql);
    return rows[0] || null;
  }

  async ensureEntry(date) {
    await this.run(`
      INSERT INTO entries(date) VALUES(${sqlQuote(date)})
      ON CONFLICT(date) DO NOTHING;
    `);
  }

  async ensureSetting(key, value) {
    await this.run(`
      INSERT INTO settings(key, value) VALUES(${sqlQuote(key)}, ${sqlQuote(value)})
      ON CONFLICT(key) DO NOTHING;
    `);
  }

  async repairEmptyDefaults() {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (key === 'openaiApiKey') continue;
      await this.run(`
        UPDATE settings
        SET value = ${sqlQuote(value)}
        WHERE key = ${sqlQuote(key)} AND trim(value) = '';
      `);
    }
    await this.run(`
      UPDATE settings
      SET value = ${sqlQuote(DEFAULT_SETTINGS.visionModel)}
      WHERE key = 'visionModel'
        AND trim(value) IN ('qwen3.6:35b-mlx', 'qwen3:latest', 'qwen3', 'qwen2.5vl:7b');
    `);
  }

  async settings() {
    await this.repairEmptyDefaults();
    const rows = await this.all('SELECT key, value FROM settings ORDER BY key;');
    return {
      ...DEFAULT_SETTINGS,
      ...Object.fromEntries(rows.map((row) => [row.key, row.value]))
    };
  }
}

function todayIso() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60 * 1000).toISOString().slice(0, 10);
}

function safeFileName(name) {
  return name.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 120);
}

function entryDir(date) {
  return path.join(currentDataDir, 'entries', date);
}

function relativeToEntry(date, absPath) {
  return path.relative(entryDir(date), absPath).split(path.sep).join('/');
}

function pathToFileUrl(filePath) {
  return `file://${filePath.split(path.sep).map((part) => encodeURIComponent(part)).join('/')}`;
}

function extensionOf(filePath) {
  return path.extname(filePath).replace('.', '').toLowerCase();
}

async function ensureDataDir(dataDir) {
  await fsp.mkdir(path.join(dataDir, 'entries'), { recursive: true });
  currentDataDir = dataDir;
  db = new DiaryDb(path.join(dataDir, 'diary.sqlite3'));
  await db.init();
  startDiaryWatcher();
}

function dateFromMarkdownPath(filePath) {
  const match = path.basename(filePath || '').match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  return match ? match[1] : '';
}

function finalDiaryPath(date) {
  return path.join(entryDir(date), `${date}.md`);
}

async function syncMarkdownDiary(date, filePath = finalDiaryPath(date), notify = false) {
  if (!date || !filePath || !fs.existsSync(filePath)) return null;
  const raw = await fsp.readFile(filePath, 'utf8');
  const text = raw.replace(/\r\n/g, '\n').replace(/\n$/, '');
  await db.ensureEntry(date);
  const entry = await db.get(`SELECT diary_text, diary_path FROM entries WHERE date = ${sqlQuote(date)};`);
  if (entry && entry.diary_text === text && entry.diary_path === filePath) {
    return { date, text, diaryPath: filePath, changed: false };
  }
  await db.run(`
    UPDATE entries
    SET diary_text = ${sqlQuote(text)},
        diary_path = ${sqlQuote(filePath)},
        updated_at = CURRENT_TIMESTAMP
    WHERE date = ${sqlQuote(date)};
  `);
  const payload = { date, text, diaryPath: filePath, changed: true };
  if (notify) {
    sendDiaryFileChanged(payload);
    sendLog(`${date} 的 Markdown 文件已同步`);
  }
  return payload;
}

function startDiaryWatcher() {
  if (diaryWatcher) {
    diaryWatcher.close();
    diaryWatcher = null;
  }
  for (const timer of diaryWatchTimers.values()) clearTimeout(timer);
  diaryWatchTimers = new Map();

  const entriesDir = path.join(currentDataDir, 'entries');
  try {
    diaryWatcher = fs.watch(entriesDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !String(filename).endsWith('.md')) return;
      const absPath = path.join(entriesDir, filename);
      const date = dateFromMarkdownPath(absPath);
      if (!date) return;
      if (diaryWatchTimers.has(absPath)) clearTimeout(diaryWatchTimers.get(absPath));
      diaryWatchTimers.set(absPath, setTimeout(async () => {
        diaryWatchTimers.delete(absPath);
        try {
          await syncMarkdownDiary(date, absPath, true);
        } catch (error) {
          sendLog(`同步 Markdown 失败：${error.message || error}`, 'error');
        }
      }, 180));
    });
  } catch (error) {
    sendLog(`Markdown 文件监听未启动：${error.message || error}`, 'error');
  }
}

function findCommand(name) {
  if (!name) return '';
  if (name.includes('/')) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return '';
    }
  }
  const searchDirs = [
    ...COMMAND_DIRS,
    ...String(process.env.PATH || '').split(path.delimiter)
  ].filter(Boolean);
  for (const dir of searchDirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  try {
    return execFileSync('/usr/bin/env', ['bash', '-lc', `command -v ${name}`], { encoding: 'utf8' }).trim();
  } catch {}
  return '';
}

function sendLog(message, level = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('job-log', { message, level, at: new Date().toISOString() });
  }
}

function sendDiaryFileChanged(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('diary-file-changed', payload);
  }
}

async function createWindow() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 650,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

async function bootstrap() {
  const config = await readAppConfig();
  await ensureDataDir(config.dataDir || DEFAULT_DATA_DIR);
  await createWindow();
}

app.whenReady().then(bootstrap);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  if (diaryWatcher) diaryWatcher.close();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('get-state', async (_event, date = todayIso()) => {
  await db.ensureEntry(date);
  await syncMarkdownDiary(date);
  const settings = await db.settings();
  const entry = await db.get(`SELECT * FROM entries WHERE date = ${sqlQuote(date)};`);
  const materials = await db.all(`
    SELECT * FROM materials
    WHERE date = ${sqlQuote(date)}
    ORDER BY datetime(created_at), id;
  `);
  const dates = await db.all(`
    SELECT e.date,
      NULLIF(e.diary_text, '') IS NOT NULL AS has_final,
      NULLIF(e.draft_text, '') IS NOT NULL AS has_draft,
      COUNT(m.id) AS material_count
    FROM entries e
    LEFT JOIN materials m ON m.date = e.date
    GROUP BY e.date
    ORDER BY e.date DESC
    LIMIT 120;
  `);
  return {
    appVersion: pkg.version,
    dataDir: currentDataDir,
    today: todayIso(),
    settings,
    entry,
    materials,
    dates,
    commands: {
      ffmpeg: findCommand('ffmpeg'),
      ollama: findCommand('ollama'),
      whisperCli: findCommand('whisper-cli'),
      whisperCpp: findCommand('whisper-cpp')
    }
  };
});

ipcMain.handle('choose-data-dir', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择日记保存文件夹',
    defaultPath: currentDataDir || DEFAULT_DATA_DIR,
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const dataDir = result.filePaths[0];
  await writeAppConfig({ ...(await readAppConfig()), dataDir });
  await ensureDataDir(dataDir);
  return dataDir;
});

ipcMain.handle('save-settings', async (_event, settings) => {
  for (const [key, value] of Object.entries(settings)) {
    const nextValue = key !== 'openaiApiKey' && !String(value || '').trim() && DEFAULT_SETTINGS[key]
      ? DEFAULT_SETTINGS[key]
      : value;
    await db.run(`
      INSERT INTO settings(key, value) VALUES(${sqlQuote(key)}, ${sqlQuote(nextValue)})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
  }
  return db.settings();
});

ipcMain.handle('save-draft', async (_event, { date, text }) => {
  await db.ensureEntry(date);
  await db.run(`
    UPDATE entries
    SET draft_text = ${sqlQuote(text)}, updated_at = CURRENT_TIMESTAMP
    WHERE date = ${sqlQuote(date)};
  `);
  return true;
});

ipcMain.handle('save-diary', async (_event, { date, text }) => {
  const diaryPath = await saveFinalDiary(date, text);
  return { diaryPath };
});

ipcMain.handle('pick-files', async (_event, type) => {
  const filters = {
    audio: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'oga', 'webm', 'mov', 'mp4', 'aiff', 'aif', 'caf'] }],
    image: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'tiff', 'tif', 'bmp'] }],
    text: [{ name: 'Text', extensions: ['txt', 'md', 'markdown', 'csv', 'json', 'log'] }]
  };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择原料',
    properties: ['openFile', 'multiSelections'],
    filters: filters[type] || []
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('import-files', async (_event, { date, type, filePaths }) => {
  await db.ensureEntry(date);
  for (const sourcePath of filePaths) {
    await importMaterialFile(date, type, sourcePath);
  }
  return true;
});

ipcMain.handle('clear-entry-workspace', async (_event, date) => {
  await db.ensureEntry(date);
  const materials = await db.all(`SELECT * FROM materials WHERE date = ${sqlQuote(date)};`);
  await db.run(`DELETE FROM materials WHERE date = ${sqlQuote(date)};`);
  await db.run(`
    UPDATE entries
    SET draft_text = '', updated_at = CURRENT_TIMESTAMP
    WHERE date = ${sqlQuote(date)};
  `);
  const rawDir = path.join(entryDir(date), 'raw');
  const previewDir = path.join(entryDir(date), 'previews');
  await fsp.rm(rawDir, { recursive: true, force: true });
  await fsp.rm(previewDir, { recursive: true, force: true });
  for (const material of materials) {
    try {
      if (material.stored_path && !material.stored_path.startsWith(rawDir)) {
        await fsp.unlink(material.stored_path);
      }
    } catch {}
  }
  return true;
});

ipcMain.handle('get-material-preview', async (_event, id) => {
  const material = await db.get(`SELECT * FROM materials WHERE id = ${sqlQuote(id)};`);
  if (!material) throw new Error('原材料不存在');
  const preview = {
    id: material.id,
    type: material.type,
    title: material.title,
    status: material.status,
    error: material.error,
    fileUrl: pathToFileUrl(material.stored_path),
    previewNote: '',
    text: ''
  };
  if (material.type === 'text') {
    preview.text = material.extracted_text || await fsp.readFile(material.stored_path, 'utf8');
  }
  if (material.type === 'audio') {
    const audioPreview = await ensureAudioPreview(material);
    preview.fileUrl = pathToFileUrl(audioPreview.path);
    preview.previewNote = audioPreview.note;
    preview.text = material.extracted_text || '';
  }
  if (material.type === 'image') {
    const imagePreview = await ensureImagePreview(material);
    preview.fileUrl = pathToFileUrl(imagePreview.path);
    preview.previewNote = imagePreview.note;
    preview.text = material.caption || '';
  }
  return preview;
});

ipcMain.handle('create-text-material', async (_event, { date, title, text }) => {
  await db.ensureEntry(date);
  const rawDir = path.join(entryDir(date), 'raw');
  await fsp.mkdir(rawDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const baseName = safeFileName(title || '文本记录');
  const storedPath = path.join(rawDir, `${stamp}-${baseName.endsWith('.md') ? baseName : `${baseName}.md`}`);
  await fsp.writeFile(storedPath, text || '', 'utf8');
  await insertMaterialRecord({
    date,
    type: 'text',
    title: path.basename(storedPath).replace(/^[^-]+-[^-]+-/, ''),
    originalPath: storedPath,
    storedPath,
    extractedText: text || '',
    status: 'ready'
  });
  return true;
});

ipcMain.handle('save-audio-recording', async (_event, { date, fileName, data }) => {
  await db.ensureEntry(date);
  const rawDir = path.join(entryDir(date), 'raw');
  await fsp.mkdir(rawDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const safeName = safeFileName(fileName || '现场录音.webm');
  const storedPath = path.join(rawDir, `${stamp}-${safeName}`);
  await fsp.writeFile(storedPath, Buffer.from(data));
  await insertMaterialRecord({
    date,
    type: 'audio',
    title: fileName || '现场录音.webm',
    originalPath: storedPath,
    storedPath,
    extractedText: '',
    status: 'pending'
  });
  return true;
});

ipcMain.handle('import-sample-materials', async (_event, date) => {
  await db.ensureEntry(date);
  const samples = await createSampleMaterials();
  for (const sample of samples) {
    await importMaterialFile(date, sample.type, sample.path);
  }
  return samples;
});

ipcMain.handle('delete-material', async (_event, id) => {
  const material = await db.get(`SELECT * FROM materials WHERE id = ${sqlQuote(id)};`);
  if (material) {
    await db.run(`DELETE FROM materials WHERE id = ${sqlQuote(id)};`);
    try {
      await fsp.unlink(material.stored_path);
    } catch {}
  }
  return true;
});

ipcMain.handle('open-data-dir', async () => {
  await shell.openPath(currentDataDir);
  return true;
});

ipcMain.handle('reveal-diary', async (_event, diaryPath) => {
  if (diaryPath) shell.showItemInFolder(diaryPath);
  return true;
});

async function importMaterialFile(date, type, sourcePath) {
  const stat = await fsp.stat(sourcePath);
  if (!stat.isFile()) return;
  const rawDir = path.join(entryDir(date), 'raw');
  await fsp.mkdir(rawDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const destPath = path.join(rawDir, `${stamp}-${safeFileName(path.basename(sourcePath))}`);
  await fsp.copyFile(sourcePath, destPath);
  let extracted = '';
  let status = 'pending';
  if (type === 'text') {
    extracted = await fsp.readFile(destPath, 'utf8');
    status = 'ready';
  }
  await insertMaterialRecord({
    date,
    type,
    title: path.basename(sourcePath),
    originalPath: sourcePath,
    storedPath: destPath,
    extractedText: extracted,
    status
  });
}

async function ensureAudioPreview(material) {
  const ext = extensionOf(material.stored_path);
  const directlyPlayable = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'webm', 'mp4']);
  if (directlyPlayable.has(ext)) {
    return { path: material.stored_path, note: '' };
  }

  const previewDir = path.join(entryDir(material.date), 'previews');
  await fsp.mkdir(previewDir, { recursive: true });
  const outputPath = path.join(previewDir, `${material.id}-audio.wav`);
  if (fs.existsSync(outputPath)) {
    return { path: outputPath, note: '已转换为 WAV 用于预览。' };
  }

  const ffmpeg = findCommand('ffmpeg');
  if (ffmpeg) {
    await runCommand(ffmpeg, ['-y', '-i', material.stored_path, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', outputPath]);
    return { path: outputPath, note: '已转换为 WAV 用于预览。' };
  }

  const afconvert = findCommand('afconvert');
  if (afconvert) {
    await runCommand(afconvert, ['-f', 'WAVE', '-d', 'LEI16@44100', material.stored_path, outputPath]);
    return { path: outputPath, note: '已转换为 WAV 用于预览。' };
  }

  return { path: material.stored_path, note: '当前格式可能无法直接播放；安装 ffmpeg 后会自动转换预览。' };
}

async function ensureImagePreview(material) {
  const ext = extensionOf(material.stored_path);
  const directlyViewable = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
  if (directlyViewable.has(ext)) {
    return { path: material.stored_path, note: '' };
  }

  const previewDir = path.join(entryDir(material.date), 'previews');
  await fsp.mkdir(previewDir, { recursive: true });
  const outputPath = path.join(previewDir, `${material.id}-image.png`);
  if (fs.existsSync(outputPath)) {
    return { path: outputPath, note: '已转换为 PNG 用于预览。' };
  }

  const sips = findCommand('sips');
  if (sips) {
    await runCommand(sips, ['-s', 'format', 'png', material.stored_path, '--out', outputPath]);
    return { path: outputPath, note: '已转换为 PNG 用于预览。' };
  }

  return { path: material.stored_path, note: '当前图片格式可能无法直接显示。' };
}

async function insertMaterialRecord({ date, type, title, originalPath, storedPath, extractedText = '', status = 'pending' }) {
  await db.run(`
    INSERT INTO materials(date, type, title, original_path, stored_path, extracted_text, status)
    VALUES(
      ${sqlQuote(date)},
      ${sqlQuote(type)},
      ${sqlQuote(title)},
      ${sqlQuote(originalPath)},
      ${sqlQuote(storedPath)},
      ${sqlQuote(extractedText)},
      ${sqlQuote(status)}
    );
  `);
}

async function createSampleMaterials() {
  const sampleDir = path.join(os.homedir(), 'diary', 'test-materials');
  await fsp.mkdir(sampleDir, { recursive: true });

  const draftPath = path.join(sampleDir, 'draft-note.txt');
  const textPath = path.join(sampleDir, 'meeting-and-evening.md');
  const audioPath = path.join(sampleDir, 'voice-note.aiff');
  const deskImagePath = path.join(sampleDir, 'desk-break.png');
  const walkImagePath = path.join(sampleDir, 'evening-walk.png');

  await fsp.writeFile(draftPath, [
    '今天上午状态有点慢，醒来以后磨蹭了一会儿。',
    '中午认真吃了一顿饭，下午把拖了两天的小任务收掉了。',
    '晚上出去走了一圈，脑子清楚了一点。今天不算特别顺，但也不是空过去的一天。'
  ].join('\n'), 'utf8');

  await fsp.writeFile(textPath, [
    '# 今天的零散记录',
    '',
    '- 上午开了一个短会，主要确认下周要交的几个点。',
    '- 下午写完了日记工具的设置页，发现很多地方不能让用户自己猜。',
    '- 晚饭后整理了一下桌面，把杯子、笔记本和充电线都收了。',
    '- 想到一件事：工具应该把麻烦藏起来，把选择留给真的需要修改的人。'
  ].join('\n'), 'utf8');

  await writeSamplePng(deskImagePath, 'desk');
  await writeSamplePng(walkImagePath, 'walk');
  await writeSampleAudio(audioPath);

  return [
    { type: 'text', path: draftPath },
    { type: 'text', path: textPath },
    { type: 'image', path: deskImagePath },
    { type: 'image', path: walkImagePath },
    { type: 'audio', path: audioPath }
  ];
}

async function writeSampleAudio(audioPath) {
  const sentence = [
    '今天其实没有特别大的事情。',
    '上午有点乱，下午慢慢把事情理顺了。',
    '晚上出去走路的时候，感觉自己终于安静下来。'
  ].join('');
  const say = findCommand('say') || '/usr/bin/say';
  try {
    await runCommand(say, ['-v', 'Tingting', '-o', audioPath, sentence]);
  } catch {
    await runCommand(say, ['-o', audioPath, sentence]);
  }
}

async function writeSamplePng(filePath, kind) {
  const width = 900;
  const height = 620;
  const rgba = Buffer.alloc(width * height * 4);

  function setPixel(x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = color[0];
    rgba[i + 1] = color[1];
    rgba[i + 2] = color[2];
    rgba[i + 3] = color[3] ?? 255;
  }

  function fillRect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) setPixel(xx, yy, color);
    }
  }

  function fillCircle(cx, cy, r, color) {
    for (let y = cy - r; y <= cy + r; y += 1) {
      for (let x = cx - r; x <= cx + r; x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r ** 2) setPixel(x, y, color);
      }
    }
  }

  if (kind === 'desk') {
    fillRect(0, 0, width, height, [239, 242, 246]);
    fillRect(0, 350, width, 270, [188, 145, 103]);
    fillRect(80, 70, 220, 180, [180, 210, 232]);
    fillRect(100, 90, 180, 140, [225, 241, 250]);
    fillRect(330, 160, 320, 210, [62, 68, 82]);
    fillRect(355, 185, 270, 160, [214, 224, 235]);
    fillRect(300, 370, 390, 28, [45, 50, 61]);
    fillRect(675, 270, 120, 82, [246, 246, 240]);
    fillCircle(735, 270, 48, [250, 250, 246]);
    fillCircle(735, 270, 30, [156, 99, 64]);
    fillRect(130, 415, 220, 130, [248, 248, 242]);
    fillRect(150, 440, 180, 10, [83, 107, 133]);
    fillRect(150, 470, 140, 10, [83, 107, 133]);
    fillRect(150, 500, 160, 10, [83, 107, 133]);
    fillRect(380, 420, 36, 130, [34, 132, 96]);
    fillRect(430, 420, 36, 130, [212, 86, 76]);
    fillRect(480, 420, 36, 130, [248, 190, 72]);
  } else {
    fillRect(0, 0, width, height, [26, 36, 54]);
    fillRect(0, 395, width, 225, [56, 65, 72]);
    fillCircle(735, 92, 42, [247, 233, 174]);
    fillRect(80, 170, 70, 230, [38, 48, 63]);
    fillRect(185, 145, 90, 255, [42, 53, 69]);
    fillRect(630, 160, 120, 240, [45, 54, 65]);
    fillRect(410, 230, 18, 235, [86, 82, 68]);
    fillCircle(419, 220, 38, [245, 202, 114]);
    fillRect(250, 465, 380, 38, [235, 235, 226]);
    fillRect(300, 520, 270, 22, [221, 221, 214]);
    fillCircle(150, 490, 30, [110, 154, 184]);
    fillRect(137, 518, 26, 68, [33, 42, 52]);
    fillCircle(610, 460, 24, [210, 138, 104]);
    fillRect(598, 484, 24, 74, [72, 86, 102]);
  }

  await fsp.writeFile(filePath, encodePng(width, height, rgba));
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const chunks = [
    pngChunk('IHDR', Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ];

  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([uint32(data.length), body, uint32(crc32(body))]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

ipcMain.handle('process-materials', async (_event, date) => {
  const settings = await db.settings();
  const materials = await db.all(`
    SELECT * FROM materials
    WHERE date = ${sqlQuote(date)} AND type IN ('audio', 'image')
    ORDER BY datetime(created_at), id;
  `);
  for (const material of materials) {
    try {
      if (material.type === 'audio' && !material.extracted_text.trim()) {
        sendLog(`开始转写：${material.title}`);
        const text = await transcribeAudio(material, settings);
        await db.run(`
          UPDATE materials
          SET extracted_text = ${sqlQuote(text)}, status = 'ready', error = ''
          WHERE id = ${sqlQuote(material.id)};
        `);
        sendLog(`转写完成：${material.title}`);
      }
      if (material.type === 'image' && (!material.caption.trim() || isNoImageResponse(material.caption))) {
        sendLog(`开始理解图片：${material.title}`);
        const caption = await describeImage(material, settings);
        await db.run(`
          UPDATE materials
          SET caption = ${sqlQuote(caption)}, status = 'ready', error = ''
          WHERE id = ${sqlQuote(material.id)};
        `);
        sendLog(`图片理解完成：${material.title}`);
      }
    } catch (error) {
      const clearCaption = material.type === 'image' ? ", caption = ''" : '';
      await db.run(`
        UPDATE materials
        SET status = 'error', error = ${sqlQuote(error.message || String(error))}${clearCaption}
        WHERE id = ${sqlQuote(material.id)};
      `);
      sendLog(`${material.title} 处理失败：${error.message || error}`, 'error');
    }
  }
  return true;
});

ipcMain.handle('generate-diary-draft', async (_event, date) => {
  await db.ensureEntry(date);
  sendLog('开始整理今天的全部材料');
  const settings = await db.settings();
  const entry = await db.get(`SELECT * FROM entries WHERE date = ${sqlQuote(date)};`);
  const materials = await db.all(`
    SELECT * FROM materials
    WHERE date = ${sqlQuote(date)}
    ORDER BY datetime(created_at), id;
  `);
  const prompt = buildDiaryPrompt(date, entry, materials, settings);
  const diaryText = await callLocalGenerate(settings, {
    model: settings.textModel,
    prompt
  });
  const clean = stripThinking(diaryText).trim();
  await db.run(`
    UPDATE entries
    SET draft_text = ${sqlQuote(clean)},
        updated_at = CURRENT_TIMESTAMP
    WHERE date = ${sqlQuote(date)};
  `);
  sendLog('日记草稿已生成');
  return { draftText: clean };
});

ipcMain.handle('generate-diary', async (_event, date) => {
  await db.ensureEntry(date);
  sendLog('开始整理今天的全部材料');
  const settings = await db.settings();
  const entry = await db.get(`SELECT * FROM entries WHERE date = ${sqlQuote(date)};`);
  const materials = await db.all(`
    SELECT * FROM materials
    WHERE date = ${sqlQuote(date)}
    ORDER BY datetime(created_at), id;
  `);
  const prompt = buildDiaryPrompt(date, entry, materials, settings);
  const diaryText = await callLocalGenerate(settings, {
    model: settings.textModel,
    prompt
  });
  const clean = stripThinking(diaryText).trim();
  const mdPath = await saveFinalDiary(date, clean);
  sendLog('日记已保存');
  return { diaryText: clean, diaryPath: mdPath };
});

async function saveFinalDiary(date, text) {
  await db.ensureEntry(date);
  const clean = stripThinking(text).trim();
  const mdPath = finalDiaryPath(date);
  await fsp.mkdir(path.dirname(mdPath), { recursive: true });
  await fsp.writeFile(mdPath, `${clean}\n`, 'utf8');
  await db.run(`
    UPDATE entries
    SET diary_text = ${sqlQuote(clean)},
        diary_path = ${sqlQuote(mdPath)},
        updated_at = CURRENT_TIMESTAMP
    WHERE date = ${sqlQuote(date)};
  `);
  return mdPath;
}

async function transcribeAudio(material, settings) {
  const ffmpeg = findCommand('ffmpeg');
  if (!ffmpeg) throw new Error('没有找到 ffmpeg，请运行 ./install.sh 安装');

  const command = settings.whisperCommand === 'auto'
    ? (findCommand('whisper-cli') || findCommand('whisper-cpp'))
    : (findCommand(settings.whisperCommand) || settings.whisperCommand);
  if (!command) throw new Error('没有找到 whisper-cli 或 whisper-cpp，请运行 ./install.sh 安装');
  if (!settings.whisperModelPath || !fs.existsSync(settings.whisperModelPath)) {
    throw new Error(`Whisper 模型不存在：${settings.whisperModelPath || '(未设置)'}`);
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'diary-audio-'));
  const wavPath = path.join(tmpDir, 'input.wav');
  const outBase = path.join(tmpDir, 'transcript');
  await runCommand(ffmpeg, ['-y', '-i', material.stored_path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);
  const { stdout, stderr } = await runCommand(command, ['-m', settings.whisperModelPath, '-f', wavPath, '-l', 'auto', '-otxt', '-of', outBase]);
  const outPath = `${outBase}.txt`;
  let text = '';
  try {
    text = await fsp.readFile(outPath, 'utf8');
  } catch {
    text = stdout || stderr;
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
  return stripWhisperNoise(text);
}

async function describeImage(material, settings) {
  const image = await fsp.readFile(material.stored_path);
  const base64 = image.toString('base64');
  const prompt = [
    '请用中文客观描述这张图片。',
    '写出画面里出现的人、地点、物品、动作、氛围，以及它可能记录的事情。',
    '不要编造看不见的信息。不要写官话。控制在 120 字以内。'
  ].join('\n');
  const result = await callLocalGenerate(settings, {
    model: settings.visionModel,
    prompt,
    images: [base64]
  });
  const clean = stripThinking(result).trim();
  if (isNoImageResponse(clean)) {
    throw new Error(`图片理解模型 ${settings.visionModel} 没有正确读取图片。请安装或选择视觉模型，例如 qwen3-vl:8b、qwen2.5vl:7b 或 llama3.2-vision。`);
  }
  return clean;
}

async function callLocalGenerate(settings, payload) {
  if ((settings.aiProvider || 'ollama') === 'openai') {
    return callOpenAICompatible({
      baseUrl: settings.ollamaBaseUrl,
      apiKey: settings.openaiApiKey,
      ...payload
    });
  }
  return callOllamaGenerate({
    baseUrl: settings.ollamaBaseUrl,
    ...payload
  });
}

async function callOllamaGenerate({ baseUrl, model, prompt, images }) {
  const hasImages = Array.isArray(images) && images.length > 0;
  const url = new URL(hasImages ? '/api/chat' : '/api/generate', baseUrl || 'http://127.0.0.1:11434');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000 * 60 * 15);
  try {
    const body = hasImages
      ? {
          model,
          messages: [{
            role: 'user',
            content: prompt,
            images
          }],
          stream: false,
          options: {
            temperature: 0.55,
            top_p: 0.9,
            num_ctx: 8192
          }
        }
      : {
          model,
          prompt,
          stream: false,
          options: {
            temperature: 0.55,
            top_p: 0.9,
            num_ctx: 8192
          }
        };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`本地 AI 返回 ${response.status}: ${body}`);
    }
    const data = await response.json();
    return hasImages ? (data.message?.content || '') : (data.response || '');
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatible({ baseUrl, apiKey, model, prompt, images }) {
  const cleanBase = (baseUrl || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const url = cleanBase.endsWith('/v1')
    ? `${cleanBase}/chat/completions`
    : `${cleanBase}/v1/chat/completions`;
  const content = images && images.length
    ? [
        { type: 'text', text: prompt },
        ...images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${image}` }
        }))
      ]
    : prompt;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000 * 60 * 15);
  try {
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        temperature: 0.55,
        top_p: 0.9
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`本地 AI 返回 ${response.status}: ${body}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

function stripThinking(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*(思考|Thinking)\s*[:：][\s\S]*?(?=\n#{1,3}\s|\n\S|$)/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripWhisperNoise(text) {
  return String(text || '')
    .replace(/\[[^\]]*(BLANK_AUDIO|MUSIC|NO_SPEECH)[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isNoImageResponse(text) {
  return /未提供图片|没有提供图片|图像不可见|画面内容不可见|无法查看图片|无法看到图片|can't see (the )?image|no image (was )?provided|image (is )?not provided/i.test(String(text || ''));
}

function buildDiaryPrompt(date, entry, materials, settings) {
  const sections = [];
  if (entry.draft_text && entry.draft_text.trim()) {
    sections.push(`【草稿文字】\n${entry.draft_text.trim()}`);
  }

  const textMaterials = materials.filter((item) => item.type === 'text' && item.extracted_text.trim());
  for (const item of textMaterials) {
    sections.push(`【文字材料：${item.title}】\n${item.extracted_text.trim()}`);
  }

  const audioMaterials = materials.filter((item) => item.type === 'audio' && item.extracted_text.trim());
  for (const item of audioMaterials) {
    sections.push(`【语音转写：${item.title}】\n${item.extracted_text.trim()}`);
  }

  const imageMaterials = materials.filter((item) => item.type === 'image');
  if (imageMaterials.length) {
    const images = imageMaterials.map((item, index) => {
      const rel = relativeToEntry(date, item.stored_path);
      const caption = item.caption && !isNoImageResponse(item.caption)
        ? item.caption.trim()
        : `这是一张已导入的图片文件：${item.title}`;
      const markdown = `![${caption.replaceAll('\n', ' ').slice(0, 60)}](${rel})`;
      return `图片${index + 1}：${caption}\n可用图片语法：${markdown}`;
    }).join('\n\n');
    sections.push(`【图片材料】\n${images}`);
  }

  return [
    settings.stylePrompt || DEFAULT_STYLE_PROMPT,
    '',
    `日期：${date}`,
    '',
    '请根据下面材料写一篇完整日记。',
    '要求：',
    '1. 只输出日记正文，使用 Markdown。',
    '2. 不要输出分析过程、提纲、免责声明、改写说明。',
    '3. 如果材料很少，也不要编造。',
    '4. 图片语法如果使用，必须原样保留相对路径。',
    '5. 篇幅自然，不要硬凑长度。',
    '',
    sections.join('\n\n') || '今天没有材料。请写一小段空白日记，提醒可以补充今天的事。'
  ].join('\n');
}
