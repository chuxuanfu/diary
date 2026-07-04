const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function exists(cmd) {
  try {
    execFileSync('/usr/bin/env', ['bash', '-lc', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const root = path.resolve(__dirname, '..');
const checks = [
  ['node_modules', fs.existsSync(path.join(root, 'node_modules'))],
  ['electron', fs.existsSync(path.join(root, 'node_modules', 'electron'))],
  ['sqlite3', exists('sqlite3')],
  ['ollama', exists('ollama')],
  ['ffmpeg', exists('ffmpeg')],
  ['whisper-cli 或 whisper-cpp', exists('whisper-cli') || exists('whisper-cpp')]
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'OK' : 'MISSING'} ${name}`);
  failed = failed || !ok;
}

process.exit(failed ? 1 : 0);
