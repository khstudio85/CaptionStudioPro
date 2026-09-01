const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

// ── Packaged-build binary paths ──────────────────────────────────────────────
// ffmpeg-static and @ffprobe-installer resolve to real .exe files inside
// node_modules. In a packaged build that path lands INSIDE app.asar, and an
// executable inside an asar archive cannot be spawned -- every export and probe
// would fail with ENOENT. electron-builder's `asarUnpack` (see package.json)
// copies both modules out to app.asar.unpacked, so rewrite the path to match.
// In development the path contains no "app.asar" and is returned unchanged.
const unpackedBin = p => (typeof p !== 'string') ? p
  : p.replace('app.asar\\', 'app.asar.unpacked\\')   // Windows separator
     .replace('app.asar/',  'app.asar.unpacked/');   // POSIX separator

const ffmpegPath = unpackedBin(require('ffmpeg-static'));

ffmpeg.setFfmpegPath(ffmpegPath);

// ffmpeg-static ships only ffmpeg (no ffprobe). Point fluent-ffmpeg at the
// bundled ffprobe binary so probe-video can read real source metadata.
let ffprobePath = null;
try {
  ffprobePath = unpackedBin(require('@ffprobe-installer/ffprobe').path);
  ffmpeg.setFfprobePath(ffprobePath);
} catch(err) {
  console.warn('[ffprobe] not available:', err.message);
}

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-accelerated-video-decode');

let mainWindow;
let currentExportCommand = null;
let exportStartTime = 0;
// Set by cancel-export so the encoder fallback ladder in _encodeCaptionVideo
// does NOT treat a user-killed FFmpeg as "this encoder is unsupported" and
// helpfully retry the whole encode with the next one.
let exportCancelled = false;

app.whenReady().then(createWindow);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false
    },
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0a',
    show: false
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src * 'unsafe-inline' 'unsafe-eval' blob: data: mediastream: filesystem: file:; " +
          "media-src * blob: data: file:; " +
          "img-src * blob: data: file:;"
        ]
      }
    });
  });

  // Local single-user app: allow permission requests (notably 'local-fonts' so
  // the Font panel can enumerate fonts installed on this PC via queryLocalFonts()).
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(true));
  try { mainWindow.webContents.session.setPermissionCheckHandler(() => true); } catch(_) {}

  mainWindow.loadFile('index.html');
  initAutoUpdater();
  // Dev only — an installed app should not open DevTools on every launch.
  // Still available in a packaged build via `--dev` or Ctrl+Shift+I / F12.
  if(!app.isPackaged || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ═══════════════════════════════════════════
// AUTO-UPDATE  (electron-updater -> GitHub Releases)
//
// Flow: check on launch -> tell the renderer -> the user decides -> download in
// the background -> install when the app quits. autoDownload stays OFF so a
// 118MB download never starts behind the user's back, and quitAndInstall is
// never called mid-session, so an in-progress export cannot be killed by it.
//
// Only runs in a packaged build: unpackaged there is no app-update.yml and
// every call throws.
// ═══════════════════════════════════════════
let autoUpdater = null;
let _updateDownloaded = false;

function _sendToWindow(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  } catch (_) {}
}

function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[update] skipped — not a packaged build');
    return;
  }
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    console.warn('[update] electron-updater unavailable:', err.message);
    return;
  }

  autoUpdater.autoDownload = false;           // ask first — never surprise-download
  autoUpdater.autoInstallOnAppQuit = true;    // apply it on the next quit

  autoUpdater.on('update-available', info => {
    console.log('[update] available:', info.version);
    _sendToWindow('update-available', { version: info.version, releaseDate: info.releaseDate });
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[update] already up to date');
    _sendToWindow('update-none', {});
  });
  autoUpdater.on('download-progress', p => {
    _sendToWindow('update-progress', {
      percent: Math.round(p.percent || 0),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });
  autoUpdater.on('update-downloaded', info => {
    console.log('[update] downloaded:', info.version);
    _updateDownloaded = true;
    _sendToWindow('update-ready', { version: info.version });
  });
  autoUpdater.on('error', err => {
    console.warn('[update] error:', err && err.message);
    _sendToWindow('update-error', { message: (err && err.message) || String(err) });
  });

  // Give the window a moment to finish loading so the first event isn't lost.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err =>
      console.warn('[update] check failed:', err && err.message));
  }, 4000);
}

ipcMain.handle('update-check', async () => {
  if (!autoUpdater) return { ok: false, reason: 'unavailable' };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
});

ipcMain.handle('update-download', async () => {
  if (!autoUpdater) return { ok: false, reason: 'unavailable' };
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
});

// Restart into the new version right now. Only offered once the download has
// finished; otherwise it does nothing rather than killing the app mid-download.
ipcMain.handle('update-install-now', async () => {
  if (!autoUpdater || !_updateDownloaded) return { ok: false, reason: 'not-ready' };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});

ipcMain.handle('update-app-version', async () => app.getVersion());

// ═══════════════════════════════════════════
// IPC HANDLERS
// ═══════════════════════════════════════════

ipcMain.handle('get-file-url', async (event, filePath) => {
  if(!filePath) return null;
  return 'file:///' + filePath.replace(/\\/g, '/');
});

ipcMain.handle('get-file-info', async (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return { success: true, size: stats.size, exists: true };
  } catch(err) {
    return { success: false, error: err.message, exists: false };
  }
});

// ═══════════════════════════════════════════
// VIDEO METADATA PROBE (ffprobe)
// Ground-truth source properties so export can
// preserve original resolution / fps / codec.
// ═══════════════════════════════════════════
ipcMain.handle('probe-video', async (event, filePath) => {
  if(!filePath) return { success: false, error: 'No file path' };
  if(!ffprobePath) return { success: false, error: 'ffprobe unavailable' };

  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if(err) { resolve({ success: false, error: err.message }); return; }
      try {
        const streams = (data && data.streams) || [];
        const format = (data && data.format) || {};
        const v = streams.find(s => s.codec_type === 'video') || {};
        const audios = streams.filter(s => s.codec_type === 'audio');
        const a = audios[0] || null;

        // r_frame_rate is exact ("30000/1001"); avg_frame_rate as fallback.
        const parseRate = (r) => {
          if(!r || typeof r !== 'string' || r.indexOf('/') < 0) return null;
          const [n, d] = r.split('/').map(Number);
          return (d && n) ? (n / d) : null;
        };
        const fpsExact = v.r_frame_rate || v.avg_frame_rate || null;
        const fpsRaw = parseRate(v.r_frame_rate) || parseRate(v.avg_frame_rate);
        const fps = fpsRaw ? Math.round(fpsRaw * 1000) / 1000 : null;

        const meta = {
          width:         v.width || null,
          height:        v.height || null,
          fps:           fps,
          fpsExact:      fpsExact,
          duration:      parseFloat(format.duration) || parseFloat(v.duration) || null,
          vCodec:        v.codec_name || null,
          aCodec:        a ? a.codec_name : null,
          bitrate:       parseInt(format.bit_rate) || null,
          pixFmt:        v.pix_fmt || null,
          sampleAspect:  v.sample_aspect_ratio || null,
          displayAspect: v.display_aspect_ratio || null,
          sampleRate:    a ? parseInt(a.sample_rate) : null,
          channels:      a ? a.channels : null,
          audioStreams:  audios.length
        };
        resolve({ success: true, meta });
      } catch(e) {
        resolve({ success: false, error: e.message });
      }
    });
  });
});

// ═══════════════════════════════════════════
// PROJECT STORE  (CapCut-style multi-project persistence)
// ───────────────────────────────────────────
// Storage choice: this is Electron, so projects live as JSON files under
// app.getPath('userData')/projects/ with a small index.json for the dashboard.
// That's the desktop equivalent of IndexedDB and strictly better here — no quota
// limits for large caption sets, survives cache clearing, and the main process
// already owns fs. Each project is its own file so one write can never corrupt
// another project, and writes are atomic (temp file + rename).
// ═══════════════════════════════════════════
const PROJECTS_SCHEMA = 1;

function _projectsDir() {
  const d = path.join(app.getPath('userData'), 'projects');
  if(!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function _projectsIndexPath() { return path.join(_projectsDir(), 'index.json'); }
function _projectFilePath(id)  { return path.join(_projectsDir(), String(id).replace(/[^A-Za-z0-9_-]/g, '') + '.json'); }

function _readIndex() {
  try {
    const p = _projectsIndexPath();
    if(!fs.existsSync(p)) return { schema: PROJECTS_SCHEMA, projects: [] };
    const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
    if(!idx || !Array.isArray(idx.projects)) return { schema: PROJECTS_SCHEMA, projects: [] };
    return idx;
  } catch(_) { return { schema: PROJECTS_SCHEMA, projects: [] }; }
}
// Atomic write so a crash mid-save can't leave a truncated file
function _writeJsonAtomic(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, filePath);
}
function _writeIndex(idx) {
  idx.schema = PROJECTS_SCHEMA;
  _writeJsonAtomic(_projectsIndexPath(), idx);
}

// List project METADATA only (fast — the dashboard never loads full projects)
// Write a text file to a user-chosen path (used by "Save Project As…" so the
// .csp copy lands in the directory the user picked in the save dialog).
ipcMain.handle('write-text-file', async (event, { filePath, contents }) => {
  try {
    if(!filePath) return { success: false, error: 'No path' };
    fs.writeFileSync(filePath, contents, 'utf8');
    return { success: true, filePath };
  } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('projects-list', async () => {
  try { return { success: true, projects: _readIndex().projects }; }
  catch(e) { return { success: false, error: e.message, projects: [] }; }
});

ipcMain.handle('projects-load', async (event, id) => {
  try {
    const p = _projectFilePath(id);
    if(!fs.existsSync(p)) return { success: false, error: 'Project not found' };
    return { success: true, data: fs.readFileSync(p, 'utf8') };
  } catch(e) { return { success: false, error: e.message }; }
});

// Save (create or update). `meta` is the dashboard card info, `data` the full state.
ipcMain.handle('projects-save', async (event, { meta, data }) => {
  try {
    if(!meta || !meta.id) return { success: false, error: 'Missing project id' };
    _writeJsonAtomic(_projectFilePath(meta.id), { meta, data: JSON.parse(data) });
    const idx = _readIndex();
    const i = idx.projects.findIndex(p => p.id === meta.id);
    if(i >= 0) idx.projects[i] = meta;      // UPDATE in place — never duplicate
    else idx.projects.push(meta);
    _writeIndex(idx);
    return { success: true, meta };
  } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('projects-rename', async (event, { id, name }) => {
  try {
    const idx = _readIndex();
    const m = idx.projects.find(p => p.id === id);
    if(!m) return { success: false, error: 'Project not found' };
    m.name = name; m.lastModified = Date.now();
    _writeIndex(idx);
    // Keep the copy inside the project file in sync
    const fp = _projectFilePath(id);
    if(fs.existsSync(fp)) {
      const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if(full && full.meta) { full.meta.name = name; full.meta.lastModified = m.lastModified; _writeJsonAtomic(fp, full); }
    }
    return { success: true, meta: m };
  } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('projects-duplicate', async (event, { id, newId, newName }) => {
  try {
    const fp = _projectFilePath(id);
    if(!fs.existsSync(fp)) return { success: false, error: 'Project not found' };
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const now = Date.now();
    const meta = Object.assign({}, full.meta, {
      id: newId, name: newName, created: now, lastModified: now
    });
    // Fully independent copy — new id, new file, deep-copied state
    _writeJsonAtomic(_projectFilePath(newId), { meta, data: full.data });
    const idx = _readIndex();
    idx.projects.push(meta);
    _writeIndex(idx);
    return { success: true, meta };
  } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('projects-delete', async (event, id) => {
  try {
    const fp = _projectFilePath(id);
    if(fs.existsSync(fp)) fs.unlinkSync(fp);     // removes only this project's file
    const idx = _readIndex();
    idx.projects = idx.projects.filter(p => p.id !== id);
    _writeIndex(idx);
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
});

// ═══════════════════════════════════════════
// LAST PROJECT (auto-save / one-click resume)
// Stored in the app's userData folder so it survives restarts and has no size
// limit (unlike localStorage). Media itself stays in place — we save the paths.
// ═══════════════════════════════════════════
function _lastProjectPath() { return path.join(app.getPath('userData'), 'last-project.json'); }

ipcMain.handle('save-last-project', async (event, jsonStr) => {
  try { fs.writeFileSync(_lastProjectPath(), jsonStr, 'utf8'); return { success: true }; }
  catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('load-last-project', async () => {
  try {
    const p = _lastProjectPath();
    if(!fs.existsSync(p)) return { success: false, error: 'none' };
    return { success: true, data: fs.readFileSync(p, 'utf8') };
  } catch(e) { return { success: false, error: e.message }; }
});

// ═══════════════════════════════════════════
// WAVEFORM PEAKS (native, any file size)
// Extracts mono PCM via FFmpeg and returns a normalized peak array so the
// timeline can show a per-file waveform even for very large videos that the
// browser can't decode. Each file gets its OWN peaks (no cross-clip reuse).
// ═══════════════════════════════════════════
ipcMain.handle('extract-waveform', async (event, options) => {
  const { videoPath } = options || {};
  if(!videoPath) return { success: false, error: 'No file path' };
  const SR = 8000;
  const outPath = path.join(app.getPath('temp'), 'wf_' + Date.now() + '.pcm');

  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(SR)
      .format('s16le')
      .on('error', (err) => { try { fs.unlinkSync(outPath); } catch(_) {} resolve({ success: false, error: err.message }); })
      .on('end', () => {
        try {
          const buf = fs.readFileSync(outPath);
          try { fs.unlinkSync(outPath); } catch(_) {}
          const samples = Math.floor(buf.length / 2);
          if(samples <= 0) { resolve({ success: false, error: 'No audio track' }); return; }
          const int16 = new Int16Array(buf.buffer, buf.byteOffset, samples);
          const durSec = samples / SR;
          const B = Math.min(240000, Math.max(4000, Math.round(durSec * 500)));  // ~500 buckets/sec
          const peaks = new Float32Array(B);
          const bucket = Math.max(1, Math.floor(samples / B));
          for(let i = 0; i < B; i++) {
            const s0 = i * bucket, s1 = Math.min(samples, s0 + bucket);
            let mx = 0;
            for(let j = s0; j < s1; j++) { const v = int16[j] < 0 ? -int16[j] : int16[j]; if(v > mx) mx = v; }
            peaks[i] = mx / 32768;
          }
          // Normalize to ~98th percentile so quiet files still show
          const sorted = Float32Array.from(peaks).sort();
          const ref = sorted[Math.floor(sorted.length * 0.98)] || 0.001;
          for(let i = 0; i < B; i++) peaks[i] = Math.min(1, peaks[i] / ref);
          resolve({ success: true, peaks: Array.from(peaks) });
        } catch(e) {
          resolve({ success: false, error: e.message });
        }
      })
      .save(outPath);
  });
});

ipcMain.handle('extract-audio-region', async (event, options) => {
  const { videoPath, startTime, endTime } = options;
  const outputPath = path.join(app.getPath('temp'), 'audio_' + Date.now() + '.wav');
  
  return new Promise((resolve, reject) => {
    const command = ffmpeg(videoPath);
    if(startTime > 0) command.setStartTime(startTime);
    if(endTime !== null && endTime !== undefined) command.setDuration(endTime - startTime);
    
    command
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => {
        try {
          const buffer = fs.readFileSync(outputPath);
          fs.unlinkSync(outputPath);
          resolve({ success: true, audioData: buffer, size: buffer.length });
        } catch(err) {
          reject({ success: false, error: err.message });
        }
      })
      .on('error', (err) => reject({ success: false, error: err.message }))
      .save(outputPath);
  });
});

ipcMain.handle('cancel-export', async () => {
  exportCancelled = true;
  if(currentExportCommand) {
    try {
      currentExportCommand.kill('SIGKILL');
      currentExportCommand = null;
      return { success: true };
    } catch(err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false };
});

// ═══════════════════════════════════════════
// CAPCUT-STYLE EXPORT — PNG Overlay Method
// This uses transparent PNG frames to preserve
// EXACT preview styling (gradients, glows, etc.)
// ═══════════════════════════════════════════

ipcMain.handle('export-with-overlay', async (event, options) => {
  const {
    videoPath, outputPath, overlayImagePath,
    resolution, trimIn, trimOut,
    quality = 'high', useGPU = true
  } = options;
  
  return new Promise((resolve, reject) => {
    try {
      exportStartTime = Date.now();
    exportCancelled = false;
      const [width, height] = resolution.split('x').map(Number);
      
      console.log('[Export] Overlay:', overlayImagePath);
      console.log('[Export] Video:', videoPath);
      console.log('[Export] Output:', outputPath);
      
      const command = ffmpeg(videoPath);
      currentExportCommand = command;
      
      if(trimIn && trimIn > 0) command.setStartTime(trimIn);
      if(trimOut && trimOut !== null) command.setDuration(trimOut - (trimIn || 0));
      
      // Add overlay input (transparent captions image)
      command.input(overlayImagePath);
      
      // Complex filter: scale video + overlay captions
      command.complexFilter([
        '[0:v]scale=' + width + ':' + height + ':flags=lanczos[bg]',
        '[bg][1:v]overlay=0:0[out]'
      ], ['out']);
      
      // GPU/CPU codec
      const gpuPresets = {
        high:   { preset: 'p6', cq: '19' },
        medium: { preset: 'p4', cq: '23' },
        low:    { preset: 'p2', cq: '28' }
      };
      const cpuPresets = {
        high:   { preset: 'medium', crf: '20' },
        medium: { preset: 'fast',   crf: '23' },
        low:    { preset: 'veryfast', crf: '28' }
      };
      
      if(useGPU) {
        const gp = gpuPresets[quality] || gpuPresets.high;
        command
          .videoCodec('h264_nvenc')
          .audioCodec('aac')
          .audioBitrate('192k')
          .outputOptions([
            '-preset', gp.preset,
            '-cq', gp.cq,
            '-b:v', '0',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-rc', 'vbr'
          ]);
      } else {
        const cp = cpuPresets[quality] || cpuPresets.medium;
        command
          .videoCodec('libx264')
          .audioCodec('aac')
          .audioBitrate('192k')
          .outputOptions([
            '-preset', cp.preset,
            '-crf', cp.crf,
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-threads', '0'
          ]);
      }
      
      command
        .on('start', (cmdLine) => {
          console.log('[FFmpeg]', cmdLine);
          event.sender.send('export-progress', {
            percent: 0, status: 'Starting...', phase: 'init'
          });
        })
        .on('progress', (progress) => {
          const percent = Math.min(99, progress.percent || 0);
          const elapsed = (Date.now() - exportStartTime) / 1000;
          let eta = null;
          if(percent > 2) {
            eta = Math.max(0, (elapsed / (percent / 100)) - elapsed);
          }
          event.sender.send('export-progress', {
            percent: percent,
            status: 'Rendering',
            phase: 'render',
            timemark: progress.timemark || '00:00:00',
            fps: progress.currentFps || 0,
            speed: progress.currentFps > 0 ? (progress.currentFps / 30).toFixed(1) + 'x' : '',
            eta: eta
          });
        })
        .on('end', () => {
          currentExportCommand = null;
          try { fs.unlinkSync(overlayImagePath); } catch(_) {}
          let fileSize = 0;
          try { fileSize = fs.statSync(outputPath).size; } catch(_) {}
          const totalTime = (Date.now() - exportStartTime) / 1000;
          event.sender.send('export-progress', {
            percent: 100, status: 'Done!', phase: 'complete', fileSize, totalTime
          });
          resolve({ success: true, outputPath, fileSize, totalTime });
        })
        .on('error', (err) => {
          currentExportCommand = null;
          try { fs.unlinkSync(overlayImagePath); } catch(_) {}
          console.error('[Export Error]', err.message);
          event.sender.send('export-progress', {
            percent: 0, status: 'Error: ' + err.message, phase: 'error'
          });
          reject({ success: false, error: err.message });
        })
        .save(outputPath);
        
    } catch(err) {
      reject({ success: false, error: err.message });
    }
  });
});

// ═══════════════════════════════════════════
// FRAME-BY-FRAME EXPORT (CapCut style)
// Renders each frame with captions overlay
// ═══════════════════════════════════════════

// Recursively remove a temp frame dir (best effort).
function _cleanupDir(dir) {
  if(!dir) return;
  try {
    fs.readdirSync(dir).forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); } catch(_) {}
    });
    fs.rmdirSync(dir);
  } catch(_) {}
}

// Does this file actually contain a video stream? Audio-only sources (.aac, .mp3,
// .wav …) have no [0:v], which made the overlay filtergraph fail with
// "Stream specifier ':v' … matches no streams / Invalid argument".
function _hasVideoStream(filePath) {
  return new Promise((resolve) => {
    if(!ffprobePath || !filePath) { resolve(true); return; }   // assume video if unknown
    ffmpeg.ffprobe(filePath, (err, data) => {
      if(err || !data || !Array.isArray(data.streams)) { resolve(true); return; }
      resolve(data.streams.some(s => s.codec_type === 'video'));
    });
  });
}

// ═══════════════════════════════════════════════════════════
// ENCODER QUALITY LADDER
// ═══════════════════════════════════════════════════════════
// Why this exists: the old settings were `-cq 19 -b:v 0 -rc vbr` and nothing
// else. NVENC's defaults are deliberately conservative — no B-frames, spatial
// AQ off, no lookahead, no multipass, `main` profile — which for caption text
// over video (hard edges, flat gradients, soft glow halos) gives both a LOWER
// bitrate and visible banding/mush versus x264 at a nominally equal CQ. That is
// the "low bitrate / doesn't look like the preview" complaint.
//
// A generous `-maxrate` ceiling matters too: some NVENC builds clamp to a low
// internal default when `-b:v 0` is used with `-rc vbr` and no ceiling is given.

// Bitrate ceiling derived from the pixel rate. This is a CEILING, not a target —
// CQ/CRF still governs the actual rate; the ceiling only stops the encoder
// starving detailed frames (and stops the NVENC `-b:v 0` clamp).
function _rateCeilingKbps(width, height, fps, bpp) {
  const pixRate = (width || 1920) * (height || 1080) * (fps || 30);
  const mbps = (pixRate * bpp * 4) / 1e6;
  return Math.round(Math.max(20, Math.min(250, mbps)) * 1000);
}

// Ordered list of encoder attempts. Each is tried in turn; if FFmpeg rejects one
// (unsupported NVENC feature on an older GPU/driver, or no NVIDIA card at all)
// the next runs. libx264 is always last so an export cannot hard-fail purely on
// encoder options.
function _encoderPlans(cfg) {
  const quality = cfg.quality, useGPU = cfg.useGPU;
  const width = cfg.width, height = cfg.height, fps = cfg.fps;

  const gpuTiers = {
    high:   { preset: 'p7', cq: '16', bpp: 0.12, lookahead: '32', aq: '8', abr: '256k' },
    medium: { preset: 'p5', cq: '20', bpp: 0.08, lookahead: '20', aq: '8', abr: '192k' },
    low:    { preset: 'p3', cq: '25', bpp: 0.05, lookahead: '8',  aq: '6', abr: '128k' }
  };
  const cpuTiers = {
    high:   { preset: 'slow',     crf: '17', bpp: 0.12, abr: '256k' },
    medium: { preset: 'medium',   crf: '20', bpp: 0.08, abr: '192k' },
    low:    { preset: 'veryfast', crf: '24', bpp: 0.05, abr: '128k' }
  };

  const gt = gpuTiers[quality] || gpuTiers.high;
  const ct = cpuTiers[quality] || cpuTiers.high;
  const gpuCeil = _rateCeilingKbps(width, height, fps, gt.bpp);
  const cpuCeil = _rateCeilingKbps(width, height, fps, ct.bpp);
  const gop = String(Math.max(12, Math.round((fps || 30) * 2)));

  const plans = [];

  if(useGPU) {
    // 1 · Full-quality NVENC (Turing / Ampere / Ada, FFmpeg 4.3+).
    //     temporal-aq, b_ref_mode and multipass are the Turing+/newer-SDK
    //     features that older cards reject outright, so they live only here.
    plans.push({
      name: 'NVENC (full quality)',
      vcodec: 'h264_nvenc',
      abitrate: gt.abr,
      opts: [
        '-preset', gt.preset, '-tune', 'hq',
        '-rc', 'vbr', '-cq', gt.cq, '-b:v', '0',
        '-maxrate', gpuCeil + 'k', '-bufsize', (gpuCeil * 2) + 'k',
        '-rc-lookahead', gt.lookahead,
        '-spatial-aq', '1', '-aq-strength', gt.aq, '-temporal-aq', '1',
        '-multipass', 'fullres',
        '-bf', '3', '-b_ref_mode', 'middle',
        '-profile:v', 'high', '-level', '5.2', '-coder', 'cabac',
        '-g', gop
      ]
    });
    // 2 · Conservative NVENC (Pascal / Maxwell / older drivers) — same rate
    //     control and spatial AQ, none of the Turing-only options.
    plans.push({
      name: 'NVENC (compatible)',
      vcodec: 'h264_nvenc',
      abitrate: gt.abr,
      opts: [
        '-preset', gt.preset,
        '-rc', 'vbr', '-cq', gt.cq, '-b:v', '0',
        '-maxrate', gpuCeil + 'k', '-bufsize', (gpuCeil * 2) + 'k',
        '-rc-lookahead', gt.lookahead,
        '-spatial-aq', '1', '-aq-strength', gt.aq,
        '-bf', '2', '-profile:v', 'high', '-level', '5.2',
        '-g', gop
      ]
    });
  }

  // 3 · x264. deblock=-1,-1 and aq-mode 3 are what keep caption edges and
  //     gradient fills from smearing; psy-rd preserves the glow falloff.
  plans.push({
    name: 'CPU (libx264)',
    vcodec: 'libx264',
    abitrate: ct.abr,
    opts: [
      '-preset', ct.preset, '-crf', ct.crf,
      '-maxrate', cpuCeil + 'k', '-bufsize', (cpuCeil * 2) + 'k',
      '-profile:v', 'high', '-level', '5.2',
      '-g', gop, '-threads', '0',
      '-x264-params',
      'aq-mode=3:aq-strength=1.0:deblock=-1,-1:psy-rd=1.0,0.15:ref=4:bframes=4:me=umh:subme=8:trellis=2'
    ]
  });

  return plans;
}

// Run ONE encoder plan. Never touches tmpDir — the caller owns cleanup so a
// failed plan can be retried with the rendered frames still on disk.
function _runEncodePlan(event, opts, plan) {
  const tmpDir = opts.tmpDir, videoPath = opts.videoPath, outputPath = opts.outputPath;
  const width = opts.width, height = opts.height;
  const fps = opts.fps, fpsExact = opts.fpsExact;
  const trimIn = opts.trimIn, trimOut = opts.trimOut;
  const hasVideo = opts.hasVideo;

  return new Promise((resolve, reject) => {
    // Exact rational rate ("30000/1001") beats the rounded decimal: 29.97 drifts
    // against the source over a long clip and desyncs the audio.
    const rate = fpsExact || String(fps);
    // FFmpeg wants 0xRRGGBB; accept "#rrggbb" from the UI
    const ffBg = '0x' + String(opts.bgColor || '#000000').replace('#', '').slice(0, 6);

    const command = ffmpeg();
    currentExportCommand = command;

    // Input 1: original video (with audio)
    command.input(videoPath);
    if(trimIn && trimIn > 0) command.inputOptions(['-ss', String(trimIn)]);
    if(trimOut && trimOut !== null) {
      command.inputOptions(['-t', String(trimOut - (trimIn || 0))]);
    }

    // Input 2: PNG sequence (transparent caption overlay)
    command.input(path.join(tmpDir, 'frame_%06d.png'));
    command.inputOptions(['-framerate', rate, '-f', 'image2']);

    // ── ALPHA BLEND (deliberately unchanged) ─────────────────────────────
    // Left at overlay's DEFAULT yuv420 blend. A 4:4:4 blend was tried here on
    // the theory that it would preserve glow / soft edges, and it measured
    // WORSE: yuva420p already carries ALPHA and LUMA at full resolution (only
    // the overlay's *chroma* subsamples), so 4:4:4 buys almost nothing on the
    // overlay while forcing the background through an extra 420→444→420 chroma
    // round-trip. Against an RGB-domain lossless reference: yuv420 blend
    // PSNR 44.2 / SSIM 0.9958, yuv444 blend 41.8 / 0.9928, rgb 43.8 / 0.9956.
    // Extra swscale flags (accurate_rnd, full_chroma_int) also measured as noise
    // on a real 1440x2560→720x1280 downscale. The washed-out / flat captions
    // were never this filtergraph — they were the canvas renderer dropping
    // shadow and glow layers (see _castShadowStack / _castGlow in
    // caption-engine.js) plus the bare encoder settings below.
    const filterStr = hasVideo
      ? '[0:v]scale=' + width + ':' + height + ':flags=lanczos,setsar=1[bg];' +
        '[1:v]scale=' + width + ':' + height + '[ov];' +
        '[bg][ov]overlay=0:0:shortest=1[out]'
      : 'color=c=' + ffBg + ':s=' + width + 'x' + height + ':r=' + rate + ',setsar=1[bg];' +
        '[1:v]scale=' + width + ':' + height + '[ov];' +
        '[bg][ov]overlay=0:0:shortest=1[out]';
    command.complexFilter(filterStr);

    const outputOpts = [
      '-map', '[out]',
      '-map', '0:a?',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-r', rate,
      '-fps_mode', 'cfr'
    ];

    command
      .videoCodec(plan.vcodec)
      .audioCodec('aac')
      .audioBitrate(plan.abitrate)
      .outputOptions(outputOpts.concat(plan.opts, ['-ar', '48000']));

    console.log('[Export] Encoder:', plan.name, '|', width + 'x' + height + '@' + rate);

    command
      .on('start', (cmdLine) => console.log('[FFmpeg CMD]', cmdLine))
      .on('progress', (progress) => {
        const percent = 15 + Math.min(83, (progress.percent || 0) * 0.83);
        const elapsed = (Date.now() - exportStartTime) / 1000;
        let eta = null;
        if(percent > 20) eta = Math.max(0, (elapsed / (percent / 100)) - elapsed);
        event.sender.send('export-progress', {
          percent: percent,
          status: 'Rendering final video',
          phase: 'render',
          timemark: progress.timemark || '00:00:00',
          fps: progress.currentFps || 0,
          speed: progress.currentFps > 0 ? (progress.currentFps / fps).toFixed(1) + 'x' : '',
          eta: eta
        });
      })
      .on('end', () => {
        currentExportCommand = null;
        resolve({ success: true });
      })
      .on('error', (err, stdout, stderr) => {
        currentExportCommand = null;
        reject({ message: err.message, stderr: stderr });
      })
      .save(outputPath);
  });
}

// Shared encode step: composite a frame_%06d.png sequence (transparent caption
// overlay) from `tmpDir` onto `videoPath` and mux the original audio →
// outputPath. Tries each encoder plan in order so an unsupported NVENC feature
// degrades to a working encoder instead of failing the whole export.
// Used by both the legacy array-based export and the streaming export.
async function _encodeCaptionVideo(event, opts) {
  const tmpDir = opts.tmpDir;
  const width = opts.width, height = opts.height;
  const fps = opts.fps == null ? 30 : opts.fps;
  const fpsExact = opts.fpsExact || null;
  const quality = opts.quality || 'high';
  const useGPU = opts.useGPU !== false;

  // Audio-only project (captions over a solid colour background)?
  const hasVideo = await _hasVideoStream(opts.videoPath);

  event.sender.send('export-progress', {
    percent: 15, status: 'Merging video + audio + captions...', phase: 'merge'
  });
  console.log('[Export] Encoding from', tmpDir, '→', opts.outputPath,
              width + 'x' + height + '@' + (fpsExact || fps),
              '| quality', quality, '| source has video:', hasVideo);

  const plans = _encoderPlans({ quality: quality, useGPU: useGPU, width: width, height: height, fps: fps });
  const planOpts = {
    tmpDir: tmpDir, videoPath: opts.videoPath, outputPath: opts.outputPath,
    width: width, height: height, fps: fps, fpsExact: fpsExact,
    trimIn: opts.trimIn, trimOut: opts.trimOut,
    bgColor: opts.bgColor || '#000000', hasVideo: hasVideo
  };

  let lastErr = null;
  for(let i = 0; i < plans.length; i++) {
    if(exportCancelled) break;              // user hit Cancel
    try {
      await _runEncodePlan(event, planOpts, plans[i]);
      _cleanupDir(tmpDir);
      let fileSize = 0;
      try { fileSize = fs.statSync(opts.outputPath).size; } catch(_) {}
      const totalTime = (Date.now() - exportStartTime) / 1000;
      console.log('[Export] SUCCESS via ' + plans[i].name + ' in ' + totalTime.toFixed(1) + 's, ' +
                  (fileSize / 1048576).toFixed(2) + 'MB');
      event.sender.send('export-progress', {
        percent: 100, status: 'Complete!', phase: 'complete',
        fileSize: fileSize, totalTime: totalTime, encoder: plans[i].name
      });
      return { success: true, outputPath: opts.outputPath, fileSize: fileSize,
               totalTime: totalTime, encoder: plans[i].name };
    } catch(err) {
      lastErr = err;
      console.error('[Export] ' + plans[i].name + ' failed:', err.message);
      if(err.stderr) console.error('[FFmpeg STDERR]', String(err.stderr).slice(-2000));
      if(exportCancelled) break;
      if(i < plans.length - 1) {
        const next = plans[i + 1].name;
        console.warn('[Export] Falling back to ' + next);
        event.sender.send('export-progress', {
          percent: 15, phase: 'merge',
          status: plans[i].name + ' unavailable — retrying with ' + next
        });
      }
    }
  }

  _cleanupDir(tmpDir);
  const msg = exportCancelled
    ? 'Export cancelled'
    : ((lastErr && lastErr.message) || 'Encode failed');
  event.sender.send('export-progress', { percent: 0, status: 'Error: ' + msg, phase: 'error' });
  throw { success: false, error: msg, stderr: lastErr && lastErr.stderr };
}

// ── Legacy array-based export (kept for backward compatibility) ──
ipcMain.handle('export-frames-mode', async (event, options) => {
  const {
    videoPath, outputPath, frameImages,
    resolution, fps = 30, trimIn, trimOut,
    quality = 'high', useGPU = true, bgColor = '#000000'
  } = options;

  return new Promise(async (resolve, reject) => {
    let tmpDir = null;
    try {
      exportStartTime = Date.now();
    exportCancelled = false;
      const [width, height] = resolution.split('x').map(Number);
      tmpDir = path.join(app.getPath('temp'), 'captionframes_' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });

      // STEP 1: Save PNG frames from the in-memory array
      for(let i = 0; i < frameImages.length; i++) {
        const framePath = path.join(tmpDir, 'frame_' + String(i).padStart(6, '0') + '.png');
        fs.writeFileSync(framePath, frameImages[i].replace(/^data:image\/png;base64,/, ''), 'base64');
        if(i % 10 === 0) {
          event.sender.send('export-progress', {
            percent: (i / frameImages.length) * 15,
            status: 'Saving frames ' + (i + 1) + '/' + frameImages.length,
            phase: 'prepare'
          });
        }
      }

      // STEP 2: Encode
      const result = await _encodeCaptionVideo(event, {
        tmpDir, videoPath, outputPath, width, height, fps, trimIn, trimOut, quality, useGPU, bgColor
      });
      resolve(result);
    } catch(err) {
      currentExportCommand = null;
      _cleanupDir(tmpDir);
      console.error('[Export Setup Error]', err);
      // _encodeCaptionVideo rejects with {error}; setup errors are Errors with {message}
      reject({ success: false, error: err.error || err.message });
    }
  });
});

// ═══════════════════════════════════════════
// STREAMING EXPORT (memory-safe)
// Renderer streams frames one at a time to disk
// instead of holding the whole sequence in RAM.
// ═══════════════════════════════════════════
const exportSessions = {};   // id → { dir }
let _exportIdCounter = 0;

ipcMain.handle('export-init', async () => {
  try {
    const id = 'exp_' + Date.now() + '_' + (++_exportIdCounter);
    const dir = path.join(app.getPath('temp'), 'captionframes_' + id);
    fs.mkdirSync(dir, { recursive: true });
    exportSessions[id] = { dir };
    exportStartTime = Date.now();
    exportCancelled = false;
    console.log('[Export] Streaming session', id, '→', dir);
    return { success: true, id, dir };
  } catch(err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('export-add-frame', async (event, { id, index, dataUrl }) => {
  try {
    const sess = exportSessions[id];
    if(!sess) return { success: false, error: 'Unknown export session: ' + id };
    const framePath = path.join(sess.dir, 'frame_' + String(index).padStart(6, '0') + '.png');
    fs.writeFileSync(framePath, dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    return { success: true };
  } catch(err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('export-encode', async (event, options) => {
  const {
    id, videoPath, outputPath,
    resolution, fps = 30, fpsExact = null, trimIn, trimOut,
    quality = 'high', useGPU = true, bgColor = '#000000'
  } = options;

  const sess = exportSessions[id];
  if(!sess) return { success: false, error: 'Unknown export session: ' + id };

  const [width, height] = resolution.split('x').map(Number);
  try {
    const result = await _encodeCaptionVideo(event, {
      tmpDir: sess.dir, videoPath, outputPath, width, height,
      fps, fpsExact, trimIn, trimOut, quality, useGPU, bgColor
    });
    delete exportSessions[id];   // dir already cleaned by _encodeCaptionVideo
    return result;
  } catch(err) {
    delete exportSessions[id];
    return { success: false, error: err.error || err.message, stderr: err.stderr };
  }
});

// Abort a streaming session that never reached encode (e.g. user cancelled during render).
ipcMain.handle('export-abort', async (event, { id }) => {
  const sess = exportSessions[id];
  if(sess) { _cleanupDir(sess.dir); delete exportSessions[id]; }
  return { success: true };
});
ipcMain.handle('save-file-dialog', async (event, options) => {
  return await dialog.showSaveDialog(mainWindow, {
    title: (options && options.title) || 'Save Video',
    defaultPath: (options && options.defaultPath) || 'exported.mp4',
    filters: (options && options.filters) || [
      { name: 'MP4 Video', extensions: ['mp4'] }
    ]
  });
});

ipcMain.handle('show-in-folder', (event, filePath) => {
  shell.showItemInFolder(filePath);
  return { success: true };
});