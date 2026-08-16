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
  
  // NEW: Frame-based export (CapCut style)
  exportFramesMode: (options) => ipcRenderer.invoke('export-frames-mode', options),
  exportWithOverlay: (options) => ipcRenderer.invoke('export-with-overlay', options),
  
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  
  saveFileDialog: (options) => ipcRenderer.invoke('save-file-dialog', options),
  showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path),
  
  onExportProgress: (callback) => {
    ipcRenderer.removeAllListeners('export-progress');
    ipcRenderer.on('export-progress', (event, data) => callback(data));
  }
});