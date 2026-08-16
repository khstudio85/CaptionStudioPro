# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Caption Studio Pro** — a desktop (Electron) video caption editor. It transcribes
audio, groups words into animated caption "groups", lets the user style them heavily
(fonts, gradients, strokes, multi-layer shadows, glow, per-word highlight, 9 animation
styles), previews them live over the video on an HTML canvas/DOM, and exports a final
MP4 by rendering caption frames as transparent PNGs and compositing them onto the video
with FFmpeg.

Think "CapCut / Premiere-style caption tool", single-user, local files, no backend of
its own (it calls external transcription APIs directly from the renderer).

## Architecture (3 processes, thin main / fat renderer)

- **`main.js`** — Electron main process. Owns the `BrowserWindow`, CSP, and all FFmpeg
  work via IPC handlers. It does NOT know anything about captions; it just composites
  PNG overlays / PNG frame sequences onto video. Heavy lifting = `export-frames-mode`
  and `export-with-overlay`.
- **`preload.js`** — contextBridge. Exposes a small `window.electronAPI` (file URLs,
  audio extraction, the two export modes, save dialog, progress events). Renderer never
  touches Node directly (`nodeIntegration: false`, `contextIsolation: true`).
- **`index.html`** — the entire app UI + ~16k lines of renderer JS inline. This is where
  virtually all product logic lives (timeline, transcription, styling, animation preview,
  frame rendering for export).
- **`caption-engine.js`** — shared rendering-spec library loaded before the inline script.
  Defines the caption style/animation/layout model. Intended as the single source of
  truth so preview and export match. See note below.

Data flow: audio/video in → transcription API → `masterWords[]` → grouped into
`wordGroups[]` → styled via UI state → previewed live → on export, each frame is drawn to
a canvas, captured as a transparent PNG, and sent to `main.js` for FFmpeg compositing.

## Running it

```bash
npm install
npm start        # electron .
npm run dev      # electron . --dev
```

There is no build step, no bundler, no test suite, and no linter configured. Editing
`index.html` / `main.js` and restarting Electron is the whole loop. DevTools opens
automatically (`main.js` calls `openDevTools()`).

## Conventions & gotchas

- **`index.html` is a 25k-line single file.** Sections are marked with `═══` banner
  comments — grep for those to navigate (e.g. `EXPORT STYLED VIDEO`, `SMART SYNC ENGINE`,
  `ANIMATION STYLE PROPERTIES`). See `FILE_CONTEXT.md` for a full section map.
- **State is module-level globals**, not a store. Key ones: `masterWords`, `wordGroups`,
  `words`, `currentAnimStyle`, `shadows`, `audioClips`, `projectFiles`, `selectedGi`.
  Changing behavior usually means finding the right global + its `update*`/`render*`
  function.
- **Two overlapping style systems exist.** `caption-engine.js` defines a clean
  `CaptionStyleSpec` / `AnimationEngine`, but a lot of the live preview and animation
  logic is ALSO reimplemented inline in `index.html` (the `if(style === N)` blocks near
  the `STYLE 0..8` banners). When changing an animation, check whether preview and export
  paths both need the edit — they don't always share code despite the engine's intent.
- **Preview↔export parity is the core risk.** Export renders via `renderCaptionFrames()`
  capturing the actual DOM/canvas, so styling changes should carry over — but verify any
  new style renders identically in the exported MP4, not just the preview.
- **GPU export assumes NVENC** (`h264_nvenc`). CPU fallback is `libx264`. The `useGPU`
  flag is passed from the renderer.
- **Transcription keys** (AssemblyAI, OpenAI Whisper) are entered in the UI and stored in
  `localStorage`. Requests go straight from the renderer to the vendor APIs.
- **The codebase mixes English and Hinglish** in comments and UI strings (e.g. "Audio
  load karo aur captions banao"). This is expected, not a bug.
- Security posture is deliberately loose for a local app: `webSecurity: false`,
  permissive CSP, `allowRunningInsecureContent`. Don't "harden" these without asking —
  they're load-local-file/video workarounds.

## When making changes

- Match the surrounding style: heavy `═══` banners, terse globals, `document.getElementById`
  everywhere (no framework).
- For a new caption style/animation: add it to the `AnimationEngine.styles` map in
  `caption-engine.js` AND the inline `STYLE N` preview block, and confirm it exports.
- For export/FFmpeg changes: they live in `main.js` IPC handlers; the renderer only
  prepares frames and calls `electronAPI.exportFramesMode` / `exportWithOverlay`.
- Test by running the app and exercising the real flow — there are no automated tests.
