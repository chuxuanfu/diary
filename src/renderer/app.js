let state = null;
let selectedDate = todayLocal();
let mode = 'final';
let busy = false;
let editorDirty = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordStream = null;

const $ = (id) => document.getElementById(id);

const els = {
  dataDirLabel: $('dataDirLabel'),
  newDiaryButton: $('newDiaryButton'),
  dateList: $('dateList'),
  openFolderButton: $('openFolderButton'),
  settingsButton: $('settingsButton'),
  dateInput: $('dateInput'),
  processButton: $('processButton'),
  saveDraftButton: $('saveDraftButton'),
  saveDiaryButton: $('saveDiaryButton'),
  workGrid: $('workGrid'),
  composeLeft: $('composeLeft'),
  addAudioButton: $('addAudioButton'),
  addTextButton: $('addTextButton'),
  addImageButton: $('addImageButton'),
  materials: $('materials'),
  log: $('log'),
  diaryTitle: $('diaryTitle'),
  diaryEditor: $('diaryEditor'),
  diaryPathLabel: $('diaryPathLabel'),
  revealDiaryButton: $('revealDiaryButton'),
  audioChoiceModal: $('audioChoiceModal'),
  closeAudioChoiceButton: $('closeAudioChoiceButton'),
  recordAudioButton: $('recordAudioButton'),
  uploadAudioButton: $('uploadAudioButton'),
  recordModal: $('recordModal'),
  closeRecordButton: $('closeRecordButton'),
  recordStatus: $('recordStatus'),
  startRecordButton: $('startRecordButton'),
  stopRecordButton: $('stopRecordButton'),
  textModal: $('textModal'),
  closeTextButton: $('closeTextButton'),
  textTitleInput: $('textTitleInput'),
  textContentInput: $('textContentInput'),
  saveTextMaterialButton: $('saveTextMaterialButton'),
  previewModal: $('previewModal'),
  closePreviewButton: $('closePreviewButton'),
  previewTitle: $('previewTitle'),
  previewSubtitle: $('previewSubtitle'),
  previewBody: $('previewBody'),
  settingsPanel: $('settingsPanel'),
  closeSettingsButton: $('closeSettingsButton'),
  dataDirInput: $('dataDirInput'),
  chooseDataDirButton: $('chooseDataDirButton'),
  aiProviderInput: $('aiProviderInput'),
  ollamaBaseUrlInput: $('ollamaBaseUrlInput'),
  openaiApiKeyInput: $('openaiApiKeyInput'),
  textModelInput: $('textModelInput'),
  visionModelInput: $('visionModelInput'),
  whisperCommandInput: $('whisperCommandInput'),
  whisperModelPathInput: $('whisperModelPathInput'),
  stylePromptInput: $('stylePromptInput'),
  envStatus: $('envStatus'),
  saveSettingsButton: $('saveSettingsButton')
};

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function cleanMarkdownImageSrc(src) {
  return String(src || '').trim().replace(/^<|>$/g, '');
}

function diaryAssetUrl(src) {
  const clean = cleanMarkdownImageSrc(src);
  if (/^(file|https?|data):/i.test(clean)) return clean;
  return window.diary.entryAssetUrl(state.dataDir, selectedDate, clean);
}

function createDiaryImageBlock(alt, src) {
  const cleanSrc = cleanMarkdownImageSrc(src);
  const block = document.createElement('figure');
  block.className = 'diary-image-block';
  block.contentEditable = 'false';
  block.dataset.alt = alt;
  block.dataset.src = cleanSrc;
  block.dataset.markdown = `![${alt}](${cleanSrc})`;

  const image = document.createElement('img');
  image.src = diaryAssetUrl(cleanSrc);
  image.alt = alt || '日记图片';
  block.appendChild(image);

  if (alt) {
    const caption = document.createElement('figcaption');
    caption.textContent = alt;
    block.appendChild(caption);
  }
  return block;
}

function setDiaryEditorText(markdown) {
  const text = String(markdown || '');
  els.diaryEditor.innerHTML = '';
  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = imagePattern.exec(text))) {
    if (match.index > lastIndex) {
      els.diaryEditor.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    els.diaryEditor.appendChild(createDiaryImageBlock(match[1], match[2]));
    lastIndex = imagePattern.lastIndex;
  }

  if (lastIndex < text.length) {
    els.diaryEditor.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  editorDirty = false;
}

function nodeToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  if (node.classList.contains('diary-image-block')) {
    return node.dataset.markdown || `![${node.dataset.alt || ''}](${node.dataset.src || ''})`;
  }

  if (node.tagName === 'BR') return '\n';

  const text = Array.from(node.childNodes).map(nodeToMarkdown).join('');
  if (['DIV', 'P'].includes(node.tagName)) {
    return text.endsWith('\n') ? text : `${text}\n`;
  }
  return text;
}

function getDiaryEditorText() {
  return Array.from(els.diaryEditor.childNodes)
    .map(nodeToMarkdown)
    .join('')
    .replace(/\u00a0/g, ' ');
}

function todayLocal() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60 * 1000).toISOString().slice(0, 10);
}

function setBusy(nextBusy) {
  busy = nextBusy;
  for (const button of [
    els.processButton,
    els.saveDraftButton,
    els.saveDiaryButton,
    els.addAudioButton,
    els.addTextButton,
    els.addImageButton
  ]) {
    if (button) button.disabled = busy;
  }
}

function addLog(message, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${level === 'error' ? 'error' : ''}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  line.textContent = `${time}  ${message}`;
  els.log.prepend(line);
}

async function load(date, nextMode = mode) {
  selectedDate = date || selectedDate || todayLocal();
  mode = nextMode;
  state = await window.diary.getState(selectedDate);
  selectedDate = state.entry.date;
  render();
}

function render() {
  if (!state) return;
  els.dataDirLabel.textContent = state.dataDir;
  els.dateInput.value = selectedDate;
  els.workGrid.classList.toggle('final-mode', mode === 'final');

  const isCompose = mode === 'compose';
  els.processButton.disabled = busy || !isCompose;
  els.saveDraftButton.disabled = busy || !isCompose;
  els.addAudioButton.disabled = busy || !isCompose;
  els.addTextButton.disabled = busy || !isCompose;
  els.addImageButton.disabled = busy || !isCompose;

  renderDates();
  renderMaterials();
  renderDiaryEditor();
  renderSettings();
}

function renderDates() {
  els.dateList.innerHTML = '';
  const dates = state.dates.length ? state.dates : [{ date: selectedDate, material_count: 0, has_final: 0, has_draft: 0 }];
  for (const item of dates) {
    const row = document.createElement('button');
    row.className = `date-item ${mode === 'final' && item.date === selectedDate ? 'active' : ''}`;
    const marker = Number(item.has_final) ? '日记' : Number(item.has_draft) ? '草稿' : `${Number(item.material_count || 0)} 项`;
    row.innerHTML = `<span>${escapeHtml(item.date)}</span><small>${escapeHtml(marker)}</small>`;
    row.addEventListener('click', () => load(item.date, 'final'));
    els.dateList.appendChild(row);
  }
}

function typeLabel(type) {
  return { audio: '音频', image: '图片', text: '文本' }[type] || type;
}

function statusLabel(status) {
  return { pending: '待处理', ready: '已完成', error: '出错' }[status] || status;
}

function renderMaterials() {
  els.materials.innerHTML = '';
  if (!state.materials.length) {
    els.materials.innerHTML = '<div class="empty">还没有原材料。添加音频、文本或图片。</div>';
    return;
  }

  for (const item of state.materials) {
    const card = document.createElement('div');
    card.className = 'material-card';
    card.tabIndex = 0;
    const body = item.error || item.extracted_text || item.caption || item.original_path;
    card.innerHTML = `
      <div class="material-title">
        <span>${escapeHtml(item.title)}</span>
        <span class="pill ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span>
      </div>
      <div class="pill">${escapeHtml(typeLabel(item.type))}</div>
      <div class="material-body">${escapeHtml(body)}</div>
      <div class="material-actions">
        <button class="ghost danger" data-delete="${item.id}">删除</button>
      </div>
    `;
    card.addEventListener('click', () => showMaterialPreview(item.id));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showMaterialPreview(item.id);
      }
    });
    card.querySelector('[data-delete]').addEventListener('click', async (event) => {
      event.stopPropagation();
      await window.diary.deleteMaterial(item.id);
      await load(selectedDate, mode);
    });
    els.materials.appendChild(card);
  }
}

function renderDiaryEditor() {
  const text = mode === 'compose'
    ? (state.entry.draft_text || '')
    : (state.entry.diary_text || '');
  setDiaryEditorText(text);
  els.diaryTitle.textContent = mode === 'compose' ? '日记展示区' : `${selectedDate} 的日记`;
  els.diaryEditor.dataset.placeholder = mode === 'compose'
    ? '处理原料后，生成的日记会出现在这里。你也可以直接修改。'
    : '这一天还没有保存正式日记。点击“新建日记”可以进入原材料处理界面。';

  if (state.entry.diary_path) {
    els.diaryPathLabel.textContent = state.entry.diary_path;
    els.revealDiaryButton.disabled = false;
  } else if (mode === 'compose') {
    els.diaryPathLabel.textContent = '保存日记后会写入当天 Markdown 文件。';
    els.revealDiaryButton.disabled = true;
  } else {
    els.diaryPathLabel.textContent = '还没有 finalized 版本。';
    els.revealDiaryButton.disabled = true;
  }
}

function renderSettings() {
  els.dataDirInput.value = state.dataDir;
  els.aiProviderInput.value = state.settings.aiProvider || 'ollama';
  els.ollamaBaseUrlInput.value = state.settings.ollamaBaseUrl || '';
  els.openaiApiKeyInput.value = state.settings.openaiApiKey || '';
  els.textModelInput.value = state.settings.textModel || '';
  els.visionModelInput.value = state.settings.visionModel || '';
  els.whisperCommandInput.value = state.settings.whisperCommand || 'auto';
  els.whisperModelPathInput.value = state.settings.whisperModelPath || '';
  els.stylePromptInput.value = state.settings.stylePrompt || '';

  const whisperCommand = state.commands.whisperCli || state.commands.whisperCpp;
  const checks = [
    { name: 'App 版本', value: state.appVersion, ok: Boolean(state.appVersion) },
    { name: 'Ollama', value: state.commands.ollama, ok: Boolean(state.commands.ollama) },
    { name: 'ffmpeg', value: state.commands.ffmpeg, ok: Boolean(state.commands.ffmpeg) },
    { name: 'Whisper 转写', value: whisperCommand, ok: Boolean(whisperCommand) },
    { name: '备用命令 whisper-cpp', value: state.commands.whisperCpp || '未安装也没关系', ok: true }
  ];
  els.envStatus.innerHTML = checks.map(({ name, value, ok }) => (
    `<div class="env-item ${ok ? 'ok' : 'warn'}">${name}: ${value ? escapeHtml(value) : '未找到'}</div>`
  )).join('');
}

function showModal(el) {
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
}

function hideModal(el) {
  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');
}

async function showMaterialPreview(id) {
  try {
    const preview = await window.diary.getMaterialPreview(id);
    els.previewTitle.textContent = preview.title;
    els.previewSubtitle.textContent = `${typeLabel(preview.type)} · ${statusLabel(preview.status)}`;
    if (preview.type === 'image') {
      els.previewBody.innerHTML = `
        <img src="${preview.fileUrl}" alt="${escapeHtml(preview.title)}">
        ${preview.previewNote ? `<p class="subtle">${escapeHtml(preview.previewNote)}</p>` : ''}
        ${preview.text ? `<pre class="preview-text">${escapeHtml(preview.text)}</pre>` : ''}
      `;
    } else if (preview.type === 'audio') {
      els.previewBody.innerHTML = `
        <audio src="${preview.fileUrl}" controls preload="metadata"></audio>
        ${preview.previewNote ? `<p class="subtle">${escapeHtml(preview.previewNote)}</p>` : ''}
        ${preview.text ? `<pre class="preview-text">${escapeHtml(preview.text)}</pre>` : '<p class="subtle">处理原料后会显示转写内容。</p>'}
      `;
    } else {
      els.previewBody.innerHTML = `<pre class="preview-text">${escapeHtml(preview.text || '')}</pre>`;
    }
    showModal(els.previewModal);
  } catch (error) {
    addLog(`预览失败：${error.message || error}`, 'error');
  }
}

async function addFiles(type) {
  const filePaths = await window.diary.pickFiles(type);
  if (!filePaths.length) return;
  await window.diary.importFiles({ date: selectedDate, type, filePaths });
  await load(selectedDate, 'compose');
}

async function runJob(fn) {
  if (busy) return;
  setBusy(true);
  try {
    await fn();
    await load(selectedDate, mode);
  } catch (error) {
    addLog(error.message || String(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function processAndGenerateDraft() {
  await window.diary.processMaterials(selectedDate);
  const result = await window.diary.generateDiaryDraft(selectedDate);
  setDiaryEditorText(result.draftText || '');
  addLog('原料处理完成，草稿已放到右侧');
}

async function saveDraft() {
  await window.diary.saveDraft({ date: selectedDate, text: getDiaryEditorText() });
  editorDirty = false;
  addLog('草稿已保存，只保存在当前编辑界面');
}

async function saveDiary() {
  await window.diary.saveDiary({ date: selectedDate, text: getDiaryEditorText() });
  editorDirty = false;
  addLog('正式日记已保存');
  await load(selectedDate, 'final');
}

async function startRecording() {
  recordedChunks = [];
  recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(recordStream);
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();
    await window.diary.saveAudioRecording({
      date: selectedDate,
      fileName: `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`,
      data: arrayBuffer
    });
    recordStream?.getTracks().forEach((track) => track.stop());
    recordStream = null;
    mediaRecorder = null;
    recordedChunks = [];
    hideModal(els.recordModal);
    await load(selectedDate, 'compose');
    addLog('现场录音已保存到原材料文件');
  };
  mediaRecorder.start();
  els.recordStatus.textContent = '正在录音。';
  els.startRecordButton.disabled = true;
  els.stopRecordButton.disabled = false;
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    els.recordStatus.textContent = '正在保存录音。';
  }
  els.startRecordButton.disabled = false;
  els.stopRecordButton.disabled = true;
}

els.newDiaryButton.addEventListener('click', () => runJob(async () => {
  if (!state) {
    await load(els.dateInput.value || selectedDate || todayLocal(), 'final');
  }
  const date = els.dateInput.value || state?.today || selectedDate || todayLocal();
  await window.diary.clearEntryWorkspace(date);
  addLog(`${date} 的新日记工作区已清空`);
  await load(date, 'compose');
}));
els.dateInput.addEventListener('change', () => load(els.dateInput.value || selectedDate || todayLocal(), 'compose'));
els.openFolderButton.addEventListener('click', () => window.diary.openDataDir());
els.settingsButton.addEventListener('click', () => showModal(els.settingsPanel));
els.closeSettingsButton.addEventListener('click', () => hideModal(els.settingsPanel));
els.processButton.addEventListener('click', () => runJob(processAndGenerateDraft));
els.saveDraftButton.addEventListener('click', () => runJob(saveDraft));
els.saveDiaryButton.addEventListener('click', () => runJob(saveDiary));
els.addAudioButton.addEventListener('click', () => showModal(els.audioChoiceModal));
els.closeAudioChoiceButton.addEventListener('click', () => hideModal(els.audioChoiceModal));
els.uploadAudioButton.addEventListener('click', async () => {
  hideModal(els.audioChoiceModal);
  await addFiles('audio');
});
els.recordAudioButton.addEventListener('click', () => {
  hideModal(els.audioChoiceModal);
  els.recordStatus.textContent = '准备开始。';
  els.startRecordButton.disabled = false;
  els.stopRecordButton.disabled = true;
  showModal(els.recordModal);
});
els.closeRecordButton.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
  hideModal(els.recordModal);
});
els.startRecordButton.addEventListener('click', () => runJob(startRecording));
els.stopRecordButton.addEventListener('click', stopRecording);
els.addTextButton.addEventListener('click', () => {
  els.textTitleInput.value = '';
  els.textContentInput.value = '';
  showModal(els.textModal);
});
els.closeTextButton.addEventListener('click', () => hideModal(els.textModal));
els.closePreviewButton.addEventListener('click', () => hideModal(els.previewModal));
els.saveTextMaterialButton.addEventListener('click', () => runJob(async () => {
  const text = els.textContentInput.value.trim();
  if (!text) throw new Error('文本内容不能为空');
  await window.diary.createTextMaterial({
    date: selectedDate,
    title: els.textTitleInput.value.trim() || '文本记录',
    text
  });
  hideModal(els.textModal);
  addLog('文本已保存到原材料文件');
}));
els.addImageButton.addEventListener('click', () => addFiles('image'));
els.revealDiaryButton.addEventListener('click', () => window.diary.revealDiary(state.entry.diary_path));
els.chooseDataDirButton.addEventListener('click', async () => {
  try {
    const dir = await window.diary.chooseDataDir();
    if (dir) {
      addLog(`保存文件夹已切换到：${dir}`);
      await load(selectedDate, mode);
    }
  } catch (error) {
    addLog(`选择保存文件夹失败：${error.message || error}`, 'error');
  }
});
els.saveSettingsButton.addEventListener('click', async () => {
  await window.diary.saveSettings({
    aiProvider: els.aiProviderInput.value,
    ollamaBaseUrl: els.ollamaBaseUrlInput.value.trim(),
    openaiApiKey: els.openaiApiKeyInput.value.trim(),
    textModel: els.textModelInput.value.trim(),
    visionModel: els.visionModelInput.value.trim(),
    whisperCommand: els.whisperCommandInput.value.trim() || 'auto',
    whisperModelPath: els.whisperModelPathInput.value.trim(),
    stylePrompt: els.stylePromptInput.value.trim()
  });
  hideModal(els.settingsPanel);
  await load(selectedDate, mode);
  addLog('设置已保存');
});

els.diaryEditor.addEventListener('input', () => {
  editorDirty = true;
});

window.diary.onJobLog((payload) => addLog(payload.message, payload.level));
window.diary.onDiaryFileChanged((payload) => {
  if (!state) return;
  if (!payload || payload.date !== selectedDate) {
    addLog(`${payload?.date || '某天'} 的 Markdown 文件已更新`);
    return;
  }
  if (mode !== 'final' || editorDirty) {
    addLog(`${payload.date} 的 Markdown 文件已更新；当前有未保存编辑，暂不覆盖`);
    return;
  }
  state.entry.diary_text = payload.text || '';
  state.entry.diary_path = payload.diaryPath || state.entry.diary_path;
  setDiaryEditorText(state.entry.diary_text);
  renderDates();
  renderDiaryEditor();
  addLog(`${payload.date} 的 Markdown 文件已刷新到界面`);
});

window.addEventListener('focus', () => {
  if (!busy && !editorDirty) {
    load(selectedDate, mode).catch((error) => addLog(`同步 Markdown 失败：${error.message || error}`, 'error'));
  }
});

els.dateInput.value = selectedDate;
load(selectedDate, 'final').catch((error) => {
  document.body.innerHTML = `<pre style="padding: 24px; white-space: pre-wrap;">${escapeHtml(error.stack || error.message || error)}</pre>`;
});
