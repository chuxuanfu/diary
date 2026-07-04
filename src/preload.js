const { contextBridge, ipcRenderer } = require('electron');

function fileUrlFromPath(filePath) {
  const clean = String(filePath || '');
  if (/^(file|https?|data):/i.test(clean)) return clean;
  return `file://${clean.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

contextBridge.exposeInMainWorld('diary', {
  getState: (date) => ipcRenderer.invoke('get-state', date),
  chooseDataDir: () => ipcRenderer.invoke('choose-data-dir'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  saveDraft: (payload) => ipcRenderer.invoke('save-draft', payload),
  saveDiary: (payload) => ipcRenderer.invoke('save-diary', payload),
  pickFiles: (type) => ipcRenderer.invoke('pick-files', type),
  importFiles: (payload) => ipcRenderer.invoke('import-files', payload),
  clearEntryWorkspace: (date) => ipcRenderer.invoke('clear-entry-workspace', date),
  getMaterialPreview: (id) => ipcRenderer.invoke('get-material-preview', id),
  createTextMaterial: (payload) => ipcRenderer.invoke('create-text-material', payload),
  saveAudioRecording: (payload) => ipcRenderer.invoke('save-audio-recording', payload),
  importSampleMaterials: (date) => ipcRenderer.invoke('import-sample-materials', date),
  deleteMaterial: (id) => ipcRenderer.invoke('delete-material', id),
  processMaterials: (date) => ipcRenderer.invoke('process-materials', date),
  generateDiaryDraft: (date) => ipcRenderer.invoke('generate-diary-draft', date),
  generateDiary: (date) => ipcRenderer.invoke('generate-diary', date),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  revealDiary: (diaryPath) => ipcRenderer.invoke('reveal-diary', diaryPath),
  onJobLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('job-log', listener);
    return () => ipcRenderer.removeListener('job-log', listener);
  },
  onDiaryFileChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('diary-file-changed', listener);
    return () => ipcRenderer.removeListener('diary-file-changed', listener);
  },
  fileUrl: (filePath) => fileUrlFromPath(filePath),
  entryAssetUrl: (dataDir, date, assetPath) => {
    if (/^(file|https?|data):/i.test(String(assetPath || ''))) return assetPath;
    const cleanAsset = String(assetPath || '').replace(/^\/+/, '');
    return fileUrlFromPath(`${dataDir.replace(/\/+$/, '')}/entries/${date}/${cleanAsset}`);
  }
});
