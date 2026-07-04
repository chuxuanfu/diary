const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const sampleDir = path.join(os.homedir(), 'diary', 'test-materials');
fs.mkdirSync(sampleDir, { recursive: true });

const files = {
  draft: path.join(sampleDir, 'draft-note.txt'),
  text: path.join(sampleDir, 'meeting-and-evening.md'),
  audio: path.join(sampleDir, 'voice-note.aiff'),
  desk: path.join(sampleDir, 'desk-break.png'),
  walk: path.join(sampleDir, 'evening-walk.png')
};

fs.writeFileSync(files.draft, [
  '今天上午状态有点慢，醒来以后磨蹭了一会儿。',
  '中午认真吃了一顿饭，下午把拖了两天的小任务收掉了。',
  '晚上出去走了一圈，脑子清楚了一点。今天不算特别顺，但也不是空过去的一天。'
].join('\n'), 'utf8');

fs.writeFileSync(files.text, [
  '# 今天的零散记录',
  '',
  '- 上午开了一个短会，主要确认下周要交的几个点。',
  '- 下午写完了日记工具的设置页，发现很多地方不能让用户自己猜。',
  '- 晚饭后整理了一下桌面，把杯子、笔记本和充电线都收了。',
  '- 想到一件事：工具应该把麻烦藏起来，把选择留给真的需要修改的人。'
].join('\n'), 'utf8');

writeSamplePng(files.desk, 'desk');
writeSamplePng(files.walk, 'walk');
writeSampleAudio(files.audio);

console.log(`测试材料已生成：${sampleDir}`);
for (const file of Object.values(files)) console.log(file);

function writeSampleAudio(audioPath) {
  const sentence = [
    '今天其实没有特别大的事情。',
    '上午有点乱，下午慢慢把事情理顺了。',
    '晚上出去走路的时候，感觉自己终于安静下来。'
  ].join('');
  try {
    execFileSync('/usr/bin/say', ['-v', 'Tingting', '-o', audioPath, sentence], { stdio: 'ignore' });
  } catch {
    execFileSync('/usr/bin/say', ['-o', audioPath, sentence], { stdio: 'ignore' });
  }
}

function writeSamplePng(filePath, kind) {
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

  fs.writeFileSync(filePath, encodePng(width, height, rgba));
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', Buffer.concat([uint32(width), uint32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
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
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
