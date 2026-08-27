const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  
  getFileURL: (filePath) => ipcRenderer.invoke('get-file-url', filePath),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  
  getFilePath: (file) => {
    try {
      if(webUtils && webUtils.getPathForFile) {
        return webUtils.getPathForFile(file);
      }
      return file.path || null;
    } catch(err) {
      return file.path || null;
    }
  },
  
  extractAudioRegion: (options) => ipcRenderer.invoke('extract-audio-region', options),

  // Read ground-truth source video metadata (resolution/fps/codec/bitrate/audio)
  probeVideo: (filePath) => ipcRenderer.invoke('probe-video', filePath),

  // Native per-file waveform peaks (works for any file size)
  getWaveformPeaks: (options) => ipcRenderer.invoke('extract-waveform', options),

  // Last-project auto-save / one-click resume
  saveLastProject: (jsonStr) => ipcRenderer.invoke('save-last-project', jsonStr),
  loadLastProject: () => ipcRenderer.invoke('load-last-project'),

  // ── Project store (multi-project: dashboard, save/load/rename/dup/delete) ──
  projectsList:      () => ipcRenderer.invoke('projects-list'),
  projectsLoad:      (id) => ipcRenderer.invoke('projects-load', id),
  projectsSave:      (payload) => ipcRenderer.invoke('projects-save', payload),
  projectsRename:    (payload) => ipcRenderer.invoke('projects-rename', payload),
  projectsDuplicate: (payload) => ipcRenderer.invoke('projects-duplicate', payload),
  projectsDelete:    (id) => ipcRenderer.invoke('projects-delete', id),
  writeTextFile:     (payload) => ipcRenderer.invoke('write-text-file', payload),
  
  // NEW: Frame-based export (CapCut style)
  exportFramesMode: (options) => ipcRenderer.invoke('export-frames-mode', options),
  exportWithOverlay: (options) => ipcRenderer.invoke('export-with-overlay', options),

  // Streaming export (memory-safe): init → add frames one by one → encode
  exportInit: () => ipcRenderer.invoke('export-init'),
  exportAddFrame: (options) => ipcRenderer.invoke('export-add-frame', options),
  exportEncode: (options) => ipcRenderer.invoke('export-encode', options),
  exportAbort: (options) => ipcRenderer.invoke('export-abort', options),
  
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  
  saveFileDialog: (options) => ipcRenderer.invoke('save-file-dialog', options),
  showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path),
  
  onExportProgress: (callback) => {
    ipcRenderer.removeAllListeners('export-progress');
    ipcRenderer.on('export-progress', (event, data) => callback(data));
  }
});