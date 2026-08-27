const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

// ffmpeg-static ships only ffmpeg (no ffprobe). Point fluent-ffmpeg at the
// bundled ffprobe binary so probe-video can read real source metadata.
let ffprobePath = null;
try {
  ffprobePath = require('@ffprobe-installer/ffprobe').path;
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
  mainWindow.webContents.openDevTools();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

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

// Shared encode step: composite a frame_%06d.png sequence (transparent caption
// overlay) from `tmpDir` onto `videoPath` and mux original audio → outputPath.
// Used by both the legacy array-based export and the streaming export.
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

async function _encodeCaptionVideo(event, opts) {
  const {
    tmpDir, videoPath, outputPath,
    width, height, fps = 30, trimIn, trimOut,
    quality = 'high', useGPU = true, bgColor = '#000000'
  } = opts;

  // Audio-only project (captions over a solid colour background)?
  const hasVideo = await _hasVideoStream(videoPath);
  // FFmpeg wants 0xRRGGBB; accept "#rrggbb" from the UI
  const ffBg = '0x' + String(bgColor || '#000000').replace('#', '').slice(0, 6);

  return new Promise((resolve, reject) => {
    event.sender.send('export-progress', {
      percent: 15, status: 'Merging video + audio + captions...', phase: 'merge'
    });
    console.log('[Export] Encoding from', tmpDir, '→', outputPath, width + 'x' + height + '@' + fps);

    const command = ffmpeg();
    currentExportCommand = command;

    // Input 1: Original video (with audio)
    command.input(videoPath);
    if(trimIn && trimIn > 0) command.inputOptions(['-ss', String(trimIn)]);
    if(trimOut && trimOut !== null) {
      command.inputOptions(['-t', String(trimOut - (trimIn || 0))]);
    }

    // Input 2: PNG sequence (captions overlay)
    command.input(path.join(tmpDir, 'frame_%06d.png'));
    command.inputOptions(['-framerate', String(fps), '-f', 'image2']);

    // Filter: build the background, then overlay the caption PNG sequence.
    //  • video source  → scale the real video
    //  • audio-only    → synthesise a solid-colour canvas (there is no [0:v])
    const filterStr = hasVideo
      ? '[0:v]scale=' + width + ':' + height + ':flags=lanczos,setsar=1[bg];' +
        '[1:v]scale=' + width + ':' + height + '[ov];' +
        '[bg][ov]overlay=0:0:shortest=1[out]'
      : 'color=c=' + ffBg + ':s=' + width + 'x' + height + ':r=' + fps + ',setsar=1[bg];' +
        '[1:v]scale=' + width + ':' + height + '[ov];' +
        '[bg][ov]overlay=0:0:shortest=1[out]';
    command.complexFilter(filterStr);
    console.log('[Export] Source has video:', hasVideo, hasVideo ? '' : '→ solid background ' + ffBg);

    const outputOpts = [
      '-map', '[out]',
      '-map', '0:a?',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-r', String(fps)
    ];

    if(useGPU) {
      const gpuPresets = {
        high:   { preset: 'p6', cq: '19' },
        medium: { preset: 'p4', cq: '23' },
        low:    { preset: 'p2', cq: '28' }
      };
      const gp = gpuPresets[quality] || gpuPresets.high;
      command
        .videoCodec('h264_nvenc')
        .audioCodec('aac')
        .audioBitrate('192k')
        .outputOptions(outputOpts.concat(['-preset', gp.preset, '-cq', gp.cq, '-b:v', '0', '-rc', 'vbr']));
      console.log('[Export] Using GPU (NVENC)');
    } else {
      const cpuPresets = {
        high:   { preset: 'medium', crf: '20' },
        medium: { preset: 'fast',   crf: '23' },
        low:    { preset: 'veryfast', crf: '28' }
      };
      const cp = cpuPresets[quality] || cpuPresets.medium;
      command
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioBitrate('192k')
        .outputOptions(outputOpts.concat(['-preset', cp.preset, '-crf', cp.crf, '-threads', '0']));
      console.log('[Export] Using CPU (libx264)');
    }

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
        _cleanupDir(tmpDir);
        let fileSize = 0;
        try { fileSize = fs.statSync(outputPath).size; } catch(_) {}
        const totalTime = (Date.now() - exportStartTime) / 1000;
        console.log('[Export] SUCCESS in ' + totalTime.toFixed(1) + 's, ' + (fileSize / 1048576).toFixed(2) + 'MB');
        event.sender.send('export-progress', {
          percent: 100, status: 'Complete!', phase: 'complete', fileSize, totalTime
        });
        resolve({ success: true, outputPath, fileSize, totalTime });
      })
      .on('error', (err, stdout, stderr) => {
        currentExportCommand = null;
        _cleanupDir(tmpDir);
        console.error('[FFmpeg ERROR]', err.message);
        if(stderr) console.error('[FFmpeg STDERR]', stderr);
        event.sender.send('export-progress', {
          percent: 0, status: 'Error: ' + err.message, phase: 'error'
        });
        reject({ success: false, error: err.message, stderr: stderr });
      })
      .save(outputPath);
  });
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
      reject({ success: false, error: err.message });
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
    resolution, fps = 30, trimIn, trimOut,
    quality = 'high', useGPU = true, bgColor = '#000000'
  } = options;

  const sess = exportSessions[id];
  if(!sess) return { success: false, error: 'Unknown export session: ' + id };

  const [width, height] = resolution.split('x').map(Number);
  try {
    const result = await _encodeCaptionVideo(event, {
      tmpDir: sess.dir, videoPath, outputPath, width, height, fps, trimIn, trimOut, quality, useGPU, bgColor
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