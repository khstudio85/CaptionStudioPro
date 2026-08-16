const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

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

ipcMain.handle('export-frames-mode', async (event, options) => {
  const {
    videoPath, outputPath, frameImages,
    resolution, fps = 30, trimIn, trimOut,
    quality = 'high', useGPU = true
  } = options;
  
  return new Promise(async (resolve, reject) => {
    let tmpDir = null;
    
    try {
      exportStartTime = Date.now();
      const [width, height] = resolution.split('x').map(Number);
      tmpDir = path.join(app.getPath('temp'), 'captionframes_' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });
      
      console.log('[Export] Frames dir:', tmpDir);
      console.log('[Export] Total frames:', frameImages.length);
      console.log('[Export] Video:', videoPath);
      console.log('[Export] Output:', outputPath);
      console.log('[Export] Resolution:', width + 'x' + height);
      console.log('[Export] FPS:', fps);
      console.log('[Export] Trim IN:', trimIn, 'OUT:', trimOut);
      
      // ═══ STEP 1: Save PNG frames ═══
      for(let i = 0; i < frameImages.length; i++) {
        const framePath = path.join(tmpDir, 'frame_' + String(i).padStart(6, '0') + '.png');
        const base64Data = frameImages[i].replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(framePath, base64Data, 'base64');
        
        if(i % 10 === 0) {
          event.sender.send('export-progress', {
            percent: (i / frameImages.length) * 15,
            status: 'Saving frames ' + (i + 1) + '/' + frameImages.length,
            phase: 'prepare'
          });
        }
      }
      
      event.sender.send('export-progress', {
        percent: 15, status: 'Merging video + audio + captions...', phase: 'merge'
      });
      
      console.log('[Export] All frames saved, starting merge...');
      
      // ═══ STEP 2: Merge everything in ONE ffmpeg command ═══
      const command = ffmpeg();
      currentExportCommand = command;
      
      // Input 1: Original video (with audio)
      command.input(videoPath);
      if(trimIn && trimIn > 0) {
        command.inputOptions(['-ss', String(trimIn)]);
      }
      if(trimOut && trimOut !== null) {
        const dur = trimOut - (trimIn || 0);
        command.inputOptions(['-t', String(dur)]);
      }
      
      // Input 2: PNG sequence (captions overlay)
      command.input(path.join(tmpDir, 'frame_%06d.png'));
      command.inputOptions([
        '-framerate', String(fps),
        '-f', 'image2'
      ]);
      
      // Filter: scale video + overlay captions
      const filterStr = 
        '[0:v]scale=' + width + ':' + height + ':flags=lanczos,setsar=1[bg];' +
        '[1:v]scale=' + width + ':' + height + '[ov];' +
        '[bg][ov]overlay=0:0:shortest=1[out]';
      
      command.complexFilter(filterStr);
      
      // Output settings
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
          .outputOptions(outputOpts.concat([
            '-preset', gp.preset,
            '-cq', gp.cq,
            '-b:v', '0',
            '-rc', 'vbr'
          ]));
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
          .outputOptions(outputOpts.concat([
            '-preset', cp.preset,
            '-crf', cp.crf,
            '-threads', '0'
          ]));
        console.log('[Export] Using CPU (libx264)');
      }
      
      command
        .on('start', (cmdLine) => {
          console.log('[FFmpeg CMD]', cmdLine);
        })
        .on('progress', (progress) => {
          const percent = 15 + Math.min(83, (progress.percent || 0) * 0.83);
          const elapsed = (Date.now() - exportStartTime) / 1000;
          let eta = null;
          if(percent > 20) {
            eta = Math.max(0, (elapsed / (percent / 100)) - elapsed);
          }
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
          
          // Cleanup temp
          try {
            fs.readdirSync(tmpDir).forEach(f => {
              try { fs.unlinkSync(path.join(tmpDir, f)); } catch(_) {}
            });
            fs.rmdirSync(tmpDir);
          } catch(_) {}
          
          let fileSize = 0;
          try { fileSize = fs.statSync(outputPath).size; } catch(_) {}
          const totalTime = (Date.now() - exportStartTime) / 1000;
          
          console.log('[Export] SUCCESS in ' + totalTime.toFixed(1) + 's');
          console.log('[Export] File size:', (fileSize / 1024 / 1024).toFixed(2) + 'MB');
          
          event.sender.send('export-progress', {
            percent: 100, status: 'Complete!', phase: 'complete', fileSize, totalTime
          });
          resolve({ success: true, outputPath, fileSize, totalTime });
        })
        .on('error', (err, stdout, stderr) => {
          currentExportCommand = null;
          console.error('[FFmpeg ERROR]', err.message);
          console.error('[FFmpeg STDERR]', stderr);
          
          // Cleanup temp
          try {
            fs.readdirSync(tmpDir).forEach(f => {
              try { fs.unlinkSync(path.join(tmpDir, f)); } catch(_) {}
            });
            fs.rmdirSync(tmpDir);
          } catch(_) {}
          
          event.sender.send('export-progress', {
            percent: 0,
            status: 'Error: ' + err.message,
            phase: 'error'
          });
          reject({ success: false, error: err.message, stderr: stderr });
        })
        .save(outputPath);
        
    } catch(err) {
      currentExportCommand = null;
      if(tmpDir) {
        try {
          fs.readdirSync(tmpDir).forEach(f => {
            try { fs.unlinkSync(path.join(tmpDir, f)); } catch(_) {}
          });
          fs.rmdirSync(tmpDir);
        } catch(_) {}
      }
      console.error('[Export Setup Error]', err);
      reject({ success: false, error: err.message });
    }
  });
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