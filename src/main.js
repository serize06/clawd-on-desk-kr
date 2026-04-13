const { app, BrowserWindow, screen, Menu, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const { applyStationaryCollectionBehavior } = require("./mac-window");
const hitGeometry = require("./hit-geometry");
const { findNearestWorkArea, computeLooseClamp, SYNTHETIC_WORK_AREA } = require("./work-area");

// ── Autoplay policy: allow sound playback without user gesture ──
// MUST be set before any BrowserWindow is created (before app.whenReady)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";
const LINUX_WINDOW_TYPE = "toolbar";


// ── Windows: AllowSetForegroundWindow via FFI ──
let _allowSetForeground = null;
if (isWin) {
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    _allowSetForeground = user32.func("bool __stdcall AllowSetForegroundWindow(int dwProcessId)");
  } catch (err) {
    console.warn("Clawd: koffi/AllowSetForegroundWindow not available:", err.message);
  }
}


// ── Window size presets ──
const SIZES = {
  S: { width: 200, height: 200 },
  M: { width: 280, height: 280 },
  L: { width: 360, height: 360 },
};

// ── Settings (prefs.js + settings-controller.js) ──
//
// `prefs.js` handles disk I/O + schema validation + migrations.
// `settings-controller.js` is the single writer of the in-memory snapshot.
// Module-level `lang`/`showTray`/etc. below are mirror caches kept in sync via
// a subscriber wired after menu.js loads. The ctx setters route writes through
// `_settingsController.applyUpdate()`, which auto-persists.
const prefsModule = require("./prefs");
const { createSettingsController } = require("./settings-controller");
const loginItemHelpers = require("./login-item");
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");
const _initialPrefsLoad = prefsModule.load(PREFS_PATH);

// Lazy helpers — these run inside the action `effect` callbacks at click time,
// long after server.js / hooks/install.js are loaded. Wrapping them in closures
// avoids a chicken-and-egg require order at module load.
function _installAutoStartHook() {
  const { registerHooks } = require("../hooks/install.js");
  registerHooks({ silent: true, autoStart: true, port: getHookServerPort() });
}
function _uninstallAutoStartHook() {
  const { unregisterAutoStart } = require("../hooks/install.js");
  unregisterAutoStart();
}

// Cross-platform "open at login" writer used by both the openAtLogin effect
// and the startup hydration helper. Throws on failure so the action layer can
// surface the error to the UI.
function _writeSystemOpenAtLogin(enabled) {
  if (isLinux) {
    const launchScript = path.join(__dirname, "..", "launch.js");
    const execCmd = app.isPackaged
      ? `"${process.env.APPIMAGE || app.getPath("exe")}"`
      : `node "${launchScript}"`;
    loginItemHelpers.linuxSetOpenAtLogin(enabled, { execCmd });
    return;
  }
  app.setLoginItemSettings(
    loginItemHelpers.getLoginItemSettings({
      isPackaged: app.isPackaged,
      openAtLogin: enabled,
      execPath: process.execPath,
      appPath: app.getAppPath(),
    })
  );
}
function _readSystemOpenAtLogin() {
  if (isLinux) return loginItemHelpers.linuxGetOpenAtLogin();
  return app.getLoginItemSettings(
    app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] }
  ).openAtLogin;
}

const _settingsController = createSettingsController({
  prefsPath: PREFS_PATH,
  loadResult: _initialPrefsLoad,
  injectedDeps: {
    installAutoStart: _installAutoStartHook,
    uninstallAutoStart: _uninstallAutoStartHook,
    setOpenAtLogin: _writeSystemOpenAtLogin,
  },
});

// Mirror of `_settingsController.get("lang")` so existing sync read sites in
// menu.js / state.js / etc. don't have to round-trip through the controller.
// Updated by the subscriber in `wireSettingsSubscribers()` below — never
// assign directly.
let lang = _settingsController.get("lang");

// First-run import of system-backed settings into prefs. The actual truth for
// `openAtLogin` lives in OS login items / autostart files; if we just trusted
// the schema default (false), an upgrading user with login-startup already
// enabled would silently lose it the first time prefs is saved. So on first
// boot after this field exists in the schema, copy the system value INTO prefs
// and mark it hydrated. After that, prefs is the source of truth and the
// openAtLogin pre-commit gate handles future writes back to the system.
//
// MUST run inside app.whenReady() — Electron's app.getLoginItemSettings() is
// only stable after the app is ready. MUST run before createWindow() so the
// first menu render reads the hydrated value.
function hydrateSystemBackedSettings() {
  if (_settingsController.get("openAtLoginHydrated")) return;
  let systemValue = false;
  try {
    systemValue = !!_readSystemOpenAtLogin();
  } catch (err) {
    console.warn("Clawd: failed to read system openAtLogin during hydration:", err && err.message);
  }
  const result = _settingsController.hydrate({
    openAtLogin: systemValue,
    openAtLoginHydrated: true,
  });
  if (result && result.status === "error") {
    console.warn("Clawd: openAtLogin hydration failed:", result.message);
  }
}

// Capture window/mini runtime state into the controller and write to disk.
// Replaces the legacy `savePrefs()` callsites — they used to read fresh
// `win.getBounds()` and `_mini.*` at save time, so we mirror that here.
function flushRuntimeStateToPrefs() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  _settingsController.applyBulk({
    x: bounds.x,
    y: bounds.y,
    positionSaved: true,
    size: currentSize,
    miniMode: _mini.getMiniMode(),
    miniEdge: _mini.getMiniEdge(),
    preMiniX: _mini.getPreMiniX(),
    preMiniY: _mini.getPreMiniY(),
  });
}

let _codexMonitor = null;          // Codex CLI JSONL log polling instance
let _geminiMonitor = null;         // Gemini CLI session JSON polling instance

// ── Theme loader ──
const themeLoader = require("./theme-loader");
themeLoader.init(__dirname, app.getPath("userData"));

let activeTheme = themeLoader.loadTheme(_settingsController.get("theme") || "clawd");

// ── CSS <object> sizing (from theme) ──
function getObjRect(bounds) {
  const state = _state.getCurrentState();
  const file = _state.getCurrentSvg() || (activeTheme && activeTheme.states && activeTheme.states.idle[0]);
  return hitGeometry.getAssetRectScreen(activeTheme, bounds, state, file)
    || { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
}

let win;
let hitWin;  // input window — small opaque rect over hitbox, receives all pointer events
let tray = null;
let contextMenuOwner = null;
// Mirror of _settingsController.get("size") — initialized from disk, kept in
// sync by the settings subscriber. The legacy S/M/L → P:N migration runs
// inside createWindow() because it needs the screen API.
let currentSize = _settingsController.get("size");

// ── Proportional size mode ──
// currentSize = "P:<ratio>" means the pet occupies <ratio>% of the work area width.
const PROPORTIONAL_RATIOS = [8, 10, 12, 15];

function isProportionalMode(size) {
  return typeof (size || currentSize) === "string" && (size || currentSize).startsWith("P:");
}

function getProportionalRatio(size) {
  return parseFloat((size || currentSize).slice(2)) || 10;
}

function getCurrentPixelSize(overrideWa) {
  if (!isProportionalMode()) return SIZES[currentSize] || SIZES.S;
  const ratio = getProportionalRatio();
  let wa = overrideWa;
  if (!wa && win && !win.isDestroyed()) {
    const { x, y, width, height } = win.getBounds();
    wa = getNearestWorkArea(x + width / 2, y + height / 2);
  }
  if (!wa) wa = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
  const px = Math.round(wa.width * ratio / 100);
  return { width: px, height: px };
}
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
// Mirror caches — kept in sync with the settings store via the subscriber
// in wireSettingsSubscribers() further down. Read freely; never assign
// directly (writes go through ctx setters → controller.applyUpdate).
let showTray = _settingsController.get("showTray");
let showDock = _settingsController.get("showDock");
let autoStartWithClaude = _settingsController.get("autoStartWithClaude");
let openAtLogin = _settingsController.get("openAtLogin");
let bubbleFollowPet = _settingsController.get("bubbleFollowPet");
let hideBubbles = _settingsController.get("hideBubbles");
let showSessionId = _settingsController.get("showSessionId");
let soundMuted = _settingsController.get("soundMuted");
let petHidden = false;
const DEFAULT_TOGGLE_SHORTCUT = "CommandOrControl+Shift+Alt+C";

function togglePetVisibility() {
  if (!win || win.isDestroyed()) return;
  if (_mini.getMiniTransitioning()) return;
  if (petHidden) {
    win.showInactive();
    if (isLinux) win.setSkipTaskbar(true);
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      if (isLinux) hitWin.setSkipTaskbar(true);
    }
    // Restore any permission bubbles that were hidden
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed()) {
        perm.bubble.showInactive();
        if (isLinux) perm.bubble.setSkipTaskbar(true);
      }
    }
    syncUpdateBubbleVisibility();
    reapplyMacVisibility();
    petHidden = false;
  } else {
    win.hide();
    if (hitWin && !hitWin.isDestroyed()) hitWin.hide();
    // Also hide any permission bubbles
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed()) perm.bubble.hide();
    }
    hideUpdateBubble();
    petHidden = true;
  }
  syncPermissionShortcuts();
  buildTrayMenu();
  buildContextMenu();
}

function registerToggleShortcut() {
  try {
    globalShortcut.register(DEFAULT_TOGGLE_SHORTCUT, togglePetVisibility);
  } catch (err) {
    console.warn("Clawd: failed to register global shortcut:", err.message);
  }
}

function unregisterToggleShortcut() {
  try {
    globalShortcut.unregister(DEFAULT_TOGGLE_SHORTCUT);
  } catch {}
}

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function sendToHitWin(channel, ...args) {
  if (hitWin && !hitWin.isDestroyed()) hitWin.webContents.send(channel, ...args);
}

function syncHitStateAfterLoad() {
  sendToHitWin("hit-state-sync", {
    currentSvg: _state.getCurrentSvg(),
    currentState: _state.getCurrentState(),
    miniMode: _mini.getMiniMode(),
    dndEnabled: doNotDisturb,
  });
}

function syncRendererStateAfterLoad({ includeStartupRecovery = true } = {}) {
  if (_mini.getMiniMode()) {
    sendToRenderer("mini-mode-change", true, _mini.getMiniEdge());
  }
  if (doNotDisturb) {
    sendToRenderer("dnd-change", true);
    if (_mini.getMiniMode()) {
      applyState("mini-sleep");
    } else {
      applyState("sleeping");
    }
    return;
  }
  if (_mini.getMiniMode()) {
    applyState("mini-idle");
    return;
  }
  if (sessions.size > 0) {
    const resolved = resolveDisplayState();
    applyState(resolved, getSvgOverride(resolved));
    return;
  }

  applyState("idle", getSvgOverride("idle"));
  if (!includeStartupRecovery) return;

  setTimeout(() => {
    if (sessions.size > 0 || doNotDisturb) return;
    detectRunningAgentProcesses((found) => {
      if (found && sessions.size === 0 && !doNotDisturb) {
        _startStartupRecovery();
        resetIdleTimer();
      }
    });
  }, 5000);
}

// ── Sound playback ──
let lastSoundTime = 0;
const SOUND_COOLDOWN_MS = 10000;

function playSound(name) {
  if (soundMuted || doNotDisturb) return;
  const now = Date.now();
  if (now - lastSoundTime < SOUND_COOLDOWN_MS) return;
  const url = themeLoader.getSoundUrl(name);
  if (!url) return;
  lastSoundTime = now;
  sendToRenderer("play-sound", url);
}

function resetSoundCooldown() {
  lastSoundTime = 0;
}

// Sync input window position to match render window's hitbox.
// Called manually after every win position/size change + event-level safety net.
let _lastHitW = 0, _lastHitH = 0;
function syncHitWin() {
  if (!hitWin || hitWin.isDestroyed() || !win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const hit = getHitRectScreen(bounds);
  const x = Math.round(hit.left);
  const y = Math.round(hit.top);
  const w = Math.round(hit.right - hit.left);
  const h = Math.round(hit.bottom - hit.top);
  if (w <= 0 || h <= 0) return;
  hitWin.setBounds({ x, y, width: w, height: h });
  // Update shape if hitbox dimensions changed (e.g. after resize)
  if (w !== _lastHitW || h !== _lastHitH) {
    _lastHitW = w; _lastHitH = h;
    hitWin.setShape([{ x: 0, y: 0, width: w, height: h }]);
  }
}

let mouseOverPet = false;
let dragLocked = false;
let menuOpen = false;
let idlePaused = false;
let forceEyeResend = false;
let themeReloadInProgress = false;

// ── Mini Mode — delegated to src/mini.js ──
// Initialized after state module (needs applyState, resolveDisplayState, etc.)
// See _mini initialization below


// ── Permission bubble — delegated to src/permission.js ──
const _permCtx = {
  get win() { return win; },
  get lang() { return lang; },
  get sessions() { return sessions; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get permDebugLog() { return permDebugLog; },
  get doNotDisturb() { return doNotDisturb; },
  get hideBubbles() { return hideBubbles; },
  get petHidden() { return petHidden; },
  getNearestWorkArea,
  getHitRectScreen,
  guardAlwaysOnTop,
  reapplyMacVisibility,
  focusTerminalForSession: (sessionId) => {
    const s = sessions.get(sessionId);
    if (s && s.sourcePid) focusTerminalWindow(s.sourcePid, s.cwd, s.editor, s.pidChain);
  },
};
const _perm = require("./permission")(_permCtx);
const { showPermissionBubble, resolvePermissionEntry, sendPermissionResponse, repositionBubbles, permLog, PASSTHROUGH_TOOLS, showCodexNotifyBubble, clearCodexNotifyBubbles, syncPermissionShortcuts, replyOpencodePermission } = _perm;
const pendingPermissions = _perm.pendingPermissions;
let permDebugLog = null; // set after app.whenReady()
let updateDebugLog = null; // set after app.whenReady()

const _updateBubbleCtx = {
  get win() { return win; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get petHidden() { return petHidden; },
  getPendingPermissions: () => pendingPermissions,
  getNearestWorkArea,
  getHitRectScreen,
  guardAlwaysOnTop,
  reapplyMacVisibility,
};
const _updateBubble = require("./update-bubble")(_updateBubbleCtx);
const {
  showUpdateBubble,
  hideUpdateBubble,
  repositionUpdateBubble,
  handleUpdateBubbleAction,
  handleUpdateBubbleHeight,
  syncVisibility: syncUpdateBubbleVisibility,
} = _updateBubble;

function repositionFloatingBubbles() {
  if (pendingPermissions.length) repositionBubbles();
  repositionUpdateBubble();
}

// ── macOS cross-Space visibility helper ──
// Prefer native collection behavior over Electron's setVisibleOnAllWorkspaces:
// Electron may briefly hide the window while transforming process type, while
// the native path also mirrors Masko Code's SkyLight-backed stationary Space.
function reapplyMacVisibility() {
  if (!isMac) return;
  const apply = (w) => {
    if (w && !w.isDestroyed()) {
      w.setAlwaysOnTop(true, MAC_TOPMOST_LEVEL);
      if (!applyStationaryCollectionBehavior(w)) {
        const opts = { visibleOnFullScreen: true };
        if (!showDock) opts.skipTransformProcessType = true;
        w.setVisibleOnAllWorkspaces(true, opts);
        // First, try the native flicker-free path.
        // If the native path fails, use Electron's cross-space API as a fallback.
        // After using Electron as a fallback, try the native enhancement again to avoid Electron resetting the window behavior we want.
        applyStationaryCollectionBehavior(w);
      }
    }
  };
  apply(win);
  apply(hitWin);
  for (const perm of pendingPermissions) apply(perm.bubble);
  apply(_updateBubble.getBubbleWindow());
  apply(contextMenuOwner);
}

// ── State machine — delegated to src/state.js ──
const _stateCtx = {
  isAgentEnabled: (agentId) => {
    try {
      const s = _settingsController.getSnapshot();
      if (!s || !s.agents) return true;
      const entry = s.agents[agentId];
      return entry ? entry.enabled !== false : true;
    } catch { return true; }
  },
  isClawdOwnSession: (sessionId) => {
    try { return sessionId && sessionId === getClawdSessionId(); } catch { return false; }
  },
  get theme() { return activeTheme; },
  get win() { return win; },
  get hitWin() { return hitWin; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  get miniMode() { return _mini.getMiniMode(); },
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  get mouseOverPet() { return mouseOverPet; },
  get miniSleepPeeked() { return _mini.getMiniSleepPeeked(); },
  set miniSleepPeeked(v) { _mini.setMiniSleepPeeked(v); },
  get miniPeeked() { return _mini.getMiniPeeked(); },
  set miniPeeked(v) { _mini.setMiniPeeked(v); },
  get idlePaused() { return idlePaused; },
  set idlePaused(v) { idlePaused = v; },
  get forceEyeResend() { return forceEyeResend; },
  set forceEyeResend(v) { forceEyeResend = v; },
  get mouseStillSince() { return _tick ? _tick._mouseStillSince : Date.now(); },
  get pendingPermissions() { return pendingPermissions; },
  get showSessionId() { return showSessionId; },
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  playSound,
  t: (key) => t(key),
  focusTerminalWindow: (...args) => focusTerminalWindow(...args),
  resolvePermissionEntry: (...args) => resolvePermissionEntry(...args),
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
};
const _state = require("./state")(_stateCtx);
const { setState, applyState, updateSession, resolveDisplayState, getSvgOverride,
        enableDoNotDisturb, disableDoNotDisturb, startStaleCleanup, stopStaleCleanup,
        startWakePoll, stopWakePoll, detectRunningAgentProcesses, buildSessionSubmenu,
        startStartupRecovery: _startStartupRecovery } = _state;
const sessions = _state.sessions;
const STATE_PRIORITY = _state.STATE_PRIORITY;

// ── Hit-test: SVG bounding box → screen coordinates ──
function getHitRectScreen(bounds) {
  const state = _state.getCurrentState();
  const file = _state.getCurrentSvg() || (activeTheme && activeTheme.states && activeTheme.states.idle[0]);
  const hit = hitGeometry.getHitRectScreen(
    activeTheme,
    bounds,
    state,
    file,
    _state.getCurrentHitBox(),
    {
      padX: _mini.getMiniMode() ? _mini.PEEK_OFFSET : 0,
      padY: _mini.getMiniMode() ? 8 : 0,
    }
  );
  return hit || { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
}

// ── Main tick — delegated to src/tick.js ──
const _tickCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
  get currentState() { return _state.getCurrentState(); },
  get currentSvg() { return _state.getCurrentSvg(); },
  get miniMode() { return _mini.getMiniMode(); },
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  get dragLocked() { return dragLocked; },
  get menuOpen() { return menuOpen; },
  get idlePaused() { return idlePaused; },
  get isAnimating() { return _mini.getIsAnimating(); },
  get miniSleepPeeked() { return _mini.getMiniSleepPeeked(); },
  set miniSleepPeeked(v) { _mini.setMiniSleepPeeked(v); },
  get miniPeeked() { return _mini.getMiniPeeked(); },
  set miniPeeked(v) { _mini.setMiniPeeked(v); },
  get mouseOverPet() { return mouseOverPet; },
  set mouseOverPet(v) { mouseOverPet = v; },
  get forceEyeResend() { return forceEyeResend; },
  set forceEyeResend(v) { forceEyeResend = v; },
  get startupRecoveryActive() { return _state.getStartupRecoveryActive(); },
  sendToRenderer,
  sendToHitWin,
  setState,
  applyState,
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  getObjRect,
  getHitRectScreen,
};
const _tick = require("./tick")(_tickCtx);
const { startMainTick, resetIdleTimer } = _tick;

// ── Terminal focus — delegated to src/focus.js ──
const _focus = require("./focus")({ _allowSetForeground });
const { initFocusHelper, killFocusHelper, focusTerminalWindow, clearMacFocusCooldownTimer } = _focus;

// ── HTTP server — delegated to src/server.js ──
const _serverCtx = {
  isAgentEnabled: (agentId) => {
    try {
      const s = _settingsController.getSnapshot();
      if (!s || !s.agents) return true;
      const e = s.agents[agentId];
      return e ? e.enabled !== false : true;
    } catch { return true; }
  },
  get autoStartWithClaude() { return autoStartWithClaude; },
  get doNotDisturb() { return doNotDisturb; },
  get hideBubbles() { return hideBubbles; },
  get pendingPermissions() { return pendingPermissions; },
  get PASSTHROUGH_TOOLS() { return PASSTHROUGH_TOOLS; },
  get STATE_SVGS() { return _state.STATE_SVGS; },
  get sessions() { return sessions; },
  setState,
  updateSession,
  resolvePermissionEntry,
  sendPermissionResponse,
  showPermissionBubble,
  replyOpencodePermission,
  permLog,
};
const _server = require("./server")(_serverCtx);
const { startHttpServer, getHookServerPort } = _server;

// ── alwaysOnTop recovery (Windows DWM / Shell can strip TOPMOST flag) ──
// The "always-on-top-changed" event only fires from Electron's own SetAlwaysOnTop
// path — it does NOT fire when Explorer/Start menu/Gallery silently reorder windows.
// So we keep the event listener for the cases it does catch (Alt/Win key), and add
// a slow watchdog (20s) to recover from silent shell-initiated z-order drops.
const WIN_TOPMOST_LEVEL = "pop-up-menu";  // above taskbar-level UI
const MAC_TOPMOST_LEVEL = "screen-saver"; // above fullscreen apps on macOS
const TOPMOST_WATCHDOG_MS = 5_000;
let topmostWatchdog = null;
let hwndRecoveryTimer = null;

// Reinitialize HWND input routing after DWM z-order disruptions.
// showInactive() (ShowWindow SW_SHOWNOACTIVATE) is the same call that makes
// the right-click context menu restore drag capability — it forces Windows to
// fully recalculate the transparent window's input target region.
function scheduleHwndRecovery() {
  if (!isWin) return;
  if (hwndRecoveryTimer) clearTimeout(hwndRecoveryTimer);
  hwndRecoveryTimer = setTimeout(() => {
    hwndRecoveryTimer = null;
    if (!win || win.isDestroyed()) return;
    // Just restore z-order — input routing is handled by hitWin now
    win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (hitWin && !hitWin.isDestroyed()) hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    forceEyeResend = true;
  }, 1000);
}

function guardAlwaysOnTop(w) {
  if (!isWin) return;
  w.on("always-on-top-changed", (_, isOnTop) => {
    if (!isOnTop && w && !w.isDestroyed()) {
      w.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      if (w === win && !dragLocked && !_mini.getIsAnimating()) {
        forceEyeResend = true;
        const { x, y } = win.getBounds();
        win.setPosition(x + 1, y);
        win.setPosition(x, y);
        syncHitWin();
        scheduleHwndRecovery();
      }
    }
  });
}

function startTopmostWatchdog() {
  if (!isWin || topmostWatchdog) return;
  topmostWatchdog = setInterval(() => {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    // Keep hitWin topmost too
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed() && perm.bubble.isVisible()) perm.bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    const updateBubbleWin = _updateBubble.getBubbleWindow();
    if (updateBubbleWin && !updateBubbleWin.isDestroyed() && updateBubbleWin.isVisible()) {
      updateBubbleWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
  }, TOPMOST_WATCHDOG_MS);
}

function stopTopmostWatchdog() {
  if (topmostWatchdog) { clearInterval(topmostWatchdog); topmostWatchdog = null; }
}

function updateLog(msg) {
  if (!updateDebugLog) return;
  const { rotatedAppend } = require("./log-rotate");
  rotatedAppend(updateDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

// ── Menu — delegated to src/menu.js ──
//
// Setters that previously assigned to module-level vars now route through
// `_settingsController.applyUpdate(key, value)`. The mirror cache is updated
// by the subscriber wired in `wireSettingsSubscribers()` after this ctx is
// built. Side effects that used to live inside setters (e.g.
// `syncPermissionShortcuts()` for hideBubbles) are now reactive and live in
// the subscriber too.
const _menuCtx = {
  get win() { return win; },
  get sessions() { return sessions; },
  showSpeech: (text, ms) => showSpeech(text, ms),
  get gravityEnabled() { return gravityEnabled; },
  set gravityEnabled(v) { gravityEnabled = !!v; if (!v && gravityTimer) { clearInterval(gravityTimer); gravityTimer = null; } },
  get followCursorEnabled() { return followCursorEnabled; },
  set followCursorEnabled(v) { followCursorEnabled = !!v; },
  get smartSpeechEnabled() { return smartSpeechEnabled; },
  set smartSpeechEnabled(v) { smartSpeechEnabled = !!v; },
  startPomodoro: (min) => startPomodoro(min),
  cancelPomodoro: () => cancelPomodoro(),
  getStatsSummary: () => getStatsSummary(),
  speakRecentCommit: () => speakRecentCommit(),
  speakAboutConversation: () => speakAboutConversation(),
  openSpeechLog: () => {
    if (speechLogWin && !speechLogWin.isDestroyed()) { speechLogWin.focus(); return; }
    const path = require("path");
    speechLogWin = new BrowserWindow({
      width: 520, height: 540,
      title: "Clawd 말 기록",
      alwaysOnTop: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-speech-log.js"),
        nodeIntegration: false, contextIsolation: true,
      },
    });
    speechLogWin.loadFile(path.join(__dirname, "speech-log.html"));
    speechLogWin.on("closed", () => { speechLogWin = null; });
  },
  askClawd: () => {
    const path = require("path");
    const askWin = new BrowserWindow({
      width: 420, height: 180,
      frame: false, transparent: false, resizable: false,
      alwaysOnTop: true, skipTaskbar: true,
      modal: false, focusable: true,
      webPreferences: {
        preload: path.join(__dirname, "preload-ask.js"),
        nodeIntegration: false, contextIsolation: true,
      },
    });
    askWin.loadFile(path.join(__dirname, "ask.html"));
    askWin.once("ready-to-show", () => {
      askWin.show();
      askWin.focus();
    });
    const onSubmit = (_e, q) => {
      askWin.close();
      // 생각중 말풍선/애니메이션 없이 조용히 대기 후 결과만 표시
      const { spawn } = require("child_process");
      const prompt = `너는 Clawd, 사용자 데스크톱에 사는 작고 귀여운 픽셀 게 친구야. AI 말투 쓰지 말고 그냥 친구가 옆에서 답하는 느낌으로 편하게. 사용자가 "${q}" 라고 말 걸었어. 반말로 짧게 50자 이내로 자연스럽게 답해. 이모지 쓰지 말고, 따옴표/줄바꿈 없이. 답만 적어.`;
      const [cmd, args] = buildClaudeCliSpawn(prompt);
      const child = spawn(cmd, args, { timeout: 60000, windowsHide: true });
      let out = "", err = "";
      child.stdout.on("data", d => out += d.toString());
      child.stderr.on("data", d => err += d.toString());
      child.on("close", (code) => {
        if (out.trim()) markClawdSessionInitialized();
        // "already in use" 에러 → init 플래그 켜고 -r로 자동 재시도
        if (err.includes("already in use") && !_clawdSessionInitialized) {
          markClawdSessionInitialized();
          const [cmd2, args2] = buildClaudeCliSpawn(prompt);
          const retry = spawn(cmd2, args2, { timeout: 60000, windowsHide: true });
          let out2 = "", err2 = "";
          retry.stdout.on("data", d => out2 += d.toString());
          retry.stderr.on("data", d => err2 += d.toString());
          retry.on("close", () => {
            const t = (out2 || "").trim().split("\n").filter(l => l.trim()).pop();
            showSpeech(t ? t.slice(0, 100) : (err2.trim().slice(-60) || "음 잘 모르겠어"), 6000);
          });
          return;
        }
        const text = (out || "").trim().split("\n").filter(l => l.trim()).pop();
        if (text) showSpeech(text.slice(0, 100), 6000);
        else showSpeech(`Claude 실패: ${(err.trim().split("\n").pop() || `exit ${code}`).slice(0, 60)}`, 5000);
      });
      child.on("error", (e) => showSpeech(`spawn 실패: ${e.message}`, 5000));
    };
    const onCancel = () => askWin.close();
    ipcMain.once("ask-submit", onSubmit);
    ipcMain.once("ask-cancel", onCancel);
    askWin.on("closed", () => {
      ipcMain.removeListener("ask-submit", onSubmit);
      ipcMain.removeListener("ask-cancel", onCancel);
    });
  },
  cloneClawd: () => {
    // 단일 인스턴스 락 때문에 별도 앱 실행은 불가. 대신 같은 프로세스 내에서 꾸미기용 분신 창을 만듦.
    try {
      if (!activeTheme) return;
      const path = require("path");
      const b = win.getBounds();
      const display = screen.getDisplayMatching(b);
      const wa = display.workArea;
      const offsetX = 200;
      const dup = new BrowserWindow({
        width: b.width, height: b.height,
        x: Math.min(wa.x + wa.width - b.width, b.x + offsetX),
        y: b.y,
        frame: false, transparent: true, resizable: false,
        alwaysOnTop: true, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      // 간단 HTML: idle SVG + 드래그 가능
      const svg = path.join(__dirname, "..", "assets", "svg", "clawd-idle-follow.svg");
      const html = `<!DOCTYPE html><html><head><style>
        html,body{margin:0;padding:0;background:transparent;-webkit-app-region:drag;overflow:hidden;cursor:move}
        object{width:100%;height:100%;pointer-events:none}
      </style></head>
      <body><object type="image/svg+xml" data="file:///${svg.replace(/\\/g,'/')}"></object></body></html>`;
      dup.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      showSpeech("복제 완료! 🐾", 3000);
    } catch (e) {
      showSpeech(`복제 실패: ${e.message}`, 3000);
    }
  },
  promptCustomPhrase: () => {
    const { dialog } = require("electron");
    dialog.showSaveDialog(win, {
      title: "커스텀 대사 추가 (파일명을 대사로 씁니다)",
      defaultPath: "오늘도 화이팅",
    }).then(r => {
      if (r.canceled || !r.filePath) return;
      const phrase = require("path").basename(r.filePath).replace(/\.(txt|md)$/, "");
      if (!phrase) return;
      const cur = getCustomPhrases();
      const next = [...cur, phrase];
      _settingsController.applyUpdate("customPhrases", next);
      showSpeech(`"${phrase}" 추가됨`, 3000);
    });
  },
  setDailyGoal: () => {
    const { dialog } = require("electron");
    dialog.showMessageBox(win, {
      message: `일일 포모도로 목표 설정`,
      detail: `현재: ${dailyPomodoroGoal}회`,
      buttons: ["2회", "4회", "6회", "8회", "취소"],
      cancelId: 4,
    }).then(r => {
      if (r.response >= 4) return;
      const goals = [2, 4, 6, 8];
      dailyPomodoroGoal = goals[r.response];
      _settingsController.applyUpdate("dailyPomodoroGoal", dailyPomodoroGoal);
      showSpeech(`목표 ${dailyPomodoroGoal}회 설정됨`, 2500);
    });
  },
  setClawdColor: () => {
    const { dialog } = require("electron");
    dialog.showMessageBox(win, {
      message: "Clawd 색상",
      buttons: ["기본 (코랄)", "파랑", "초록", "보라", "분홍", "취소"],
      cancelId: 5,
    }).then(r => {
      const colors = ["", "#4a90e2", "#3ece7f", "#9b59b6", "#ff6fa5"];
      if (r.response >= 5) return;
      const c = colors[r.response];
      _settingsController.applyUpdate("clawdColor", c);
      if (win) win.webContents.send("set-clawd-color", c);
      showSpeech("색 바꿨어", 2500);
    });
  },
  get walkEnabled() { return walkEnabled; },
  set walkEnabled(v) {
    walkEnabled = !!v;
    if (!walkEnabled && walking) {
      try { setState("idle"); } catch {}
      try { win.webContents.send("set-facing", "left"); } catch {}
      walking = false;
    }
  },
  triggerState: (state) => {
    // 테마 state → (실제 state, svgOverride)
    const ALIAS = {
      happy:       ["attention",  "clawd-happy.svg"],
      typing:      ["working",    "clawd-working-typing.svg"],
      building:    ["working",    "clawd-working-building.svg"],
      conducting:  ["juggling",   "clawd-working-conducting.svg"],
      walking:     ["working",    "clawd-crab-walking.svg"],
      dizzy:       ["error",      "clawd-dizzy.svg"],
      disconnected:["error",      "clawd-disconnected.svg"],
      "going-away":["error",      "clawd-going-away.svg"],
      beacon:      ["working",    "clawd-working-beacon.svg"],
      confused:    ["thinking",   "clawd-working-confused.svg"],
      overheated:  ["error",      "clawd-working-overheated.svg"],
      pushing:     ["working",    "clawd-working-pushing.svg"],
      wizard:      ["working",    "clawd-working-wizard.svg"],
    };
    const [realState, svg] = ALIAS[state] || [state, null];
    try { setState(realState, svg); } catch (e) { console.error("triggerState:", e); }
  },
  get currentSize() { return currentSize; },
  set currentSize(v) { _settingsController.applyUpdate("size", v); },
  get doNotDisturb() { return doNotDisturb; },
  get lang() { return lang; },
  set lang(v) { _settingsController.applyUpdate("lang", v); },
  get showTray() { return showTray; },
  set showTray(v) { _settingsController.applyUpdate("showTray", v); },
  get showDock() { return showDock; },
  set showDock(v) { _settingsController.applyUpdate("showDock", v); },
  get autoStartWithClaude() { return autoStartWithClaude; },
  set autoStartWithClaude(v) { _settingsController.applyUpdate("autoStartWithClaude", v); },
  get openAtLogin() { return openAtLogin; },
  set openAtLogin(v) { _settingsController.applyUpdate("openAtLogin", v); },
  get bubbleFollowPet() { return bubbleFollowPet; },
  set bubbleFollowPet(v) { _settingsController.applyUpdate("bubbleFollowPet", v); },
  get hideBubbles() { return hideBubbles; },
  set hideBubbles(v) { _settingsController.applyUpdate("hideBubbles", v); },
  get showSessionId() { return showSessionId; },
  set showSessionId(v) { _settingsController.applyUpdate("showSessionId", v); },
  get soundMuted() { return soundMuted; },
  set soundMuted(v) { _settingsController.applyUpdate("soundMuted", v); },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionFloatingBubbles(),
  get petHidden() { return petHidden; },
  togglePetVisibility: () => togglePetVisibility(),
  get isQuitting() { return isQuitting; },
  set isQuitting(v) { isQuitting = v; },
  get menuOpen() { return menuOpen; },
  set menuOpen(v) { menuOpen = v; },
  get tray() { return tray; },
  set tray(v) { tray = v; },
  get contextMenuOwner() { return contextMenuOwner; },
  set contextMenuOwner(v) { contextMenuOwner = v; },
  get contextMenu() { return contextMenu; },
  set contextMenu(v) { contextMenu = v; },
  enableDoNotDisturb: () => enableDoNotDisturb(),
  disableDoNotDisturb: () => disableDoNotDisturb(),
  enterMiniViaMenu: () => enterMiniViaMenu(),
  exitMiniMode: () => exitMiniMode(),
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  miniHandleResize: (sizeKey) => _mini.handleResize(sizeKey),
  focusTerminalWindow: (...args) => focusTerminalWindow(...args),
  checkForUpdates: (...args) => checkForUpdates(...args),
  getUpdateMenuItem: () => getUpdateMenuItem(),
  buildSessionSubmenu: () => buildSessionSubmenu(),
  // The settings controller is the only writer of persisted prefs. Toggle
  // setters above route through it; resize/sendToDisplay use
  // flushRuntimeStateToPrefs to capture window bounds after movement.
  flushRuntimeStateToPrefs,
  settings: _settingsController,
  syncHitWin,
  getCurrentPixelSize,
  isProportionalMode,
  PROPORTIONAL_RATIOS,
  getHookServerPort: () => getHookServerPort(),
  clampToScreen,
  getNearestWorkArea,
  reapplyMacVisibility,
  switchTheme: (id) => switchTheme(id),
  discoverThemes: () => themeLoader.discoverThemes(),
  getActiveThemeId: () => activeTheme ? activeTheme._id : "clawd",
  ensureUserThemesDir: () => themeLoader.ensureUserThemesDir(),
  openSettingsWindow: () => openSettingsWindow(),
};
const _menu = require("./menu")(_menuCtx);
const { t, buildContextMenu, buildTrayMenu, rebuildAllMenus, createTray,
        destroyTray, showPetContextMenu, popupMenuAt, ensureContextMenuOwner,
        requestAppQuit, applyDockVisibility } = _menu;

// ── Settings subscribers ──
//
// Single source of truth: any change to `_settingsController` lands here
// first. We update the mirror caches above (so existing sync read sites
// still work), then fire reactive side effects (menu rebuild, permission
// shortcut resync, bubble reposition, etc.). Setters in the ctx above
// route writes through the controller, so menu clicks and IPC updates
// from a future settings panel land here identically.
const MENU_AFFECTING_KEYS = new Set([
  "lang", "soundMuted", "bubbleFollowPet", "hideBubbles", "showSessionId",
  "autoStartWithClaude", "openAtLogin", "showTray", "showDock", "theme", "size",
]);
function wireSettingsSubscribers() {
  _settingsController.subscribe(({ changes }) => {
    // 1. Update mirror caches first so any side-effect handler reads fresh values.
    if ("lang" in changes) lang = changes.lang;
    if ("size" in changes) currentSize = changes.size;
    if ("showTray" in changes) {
      showTray = changes.showTray;
      try { changes.showTray ? createTray() : destroyTray(); } catch (err) {
        console.warn("Clawd: tray toggle failed:", err && err.message);
      }
    }
    if ("showDock" in changes) {
      showDock = changes.showDock;
      try { applyDockVisibility(); } catch (err) {
        console.warn("Clawd: applyDockVisibility failed:", err && err.message);
      }
    }
    // autoStartWithClaude / openAtLogin are object-form pre-commit gates in
    // settings-actions.js — by the time we get here the system call already
    // succeeded (or the commit was rejected), so the subscriber only needs
    // to update the mirror cache. No more registerHooks/setLoginItemSettings
    // here; that violates the unidirectional flow (see plan §4.2).
    if ("autoStartWithClaude" in changes) {
      autoStartWithClaude = changes.autoStartWithClaude;
    }
    if ("openAtLogin" in changes) {
      openAtLogin = changes.openAtLogin;
    }
    if ("bubbleFollowPet" in changes) bubbleFollowPet = changes.bubbleFollowPet;
    if ("hideBubbles" in changes) hideBubbles = changes.hideBubbles;
    if ("showSessionId" in changes) showSessionId = changes.showSessionId;
    if ("soundMuted" in changes) soundMuted = changes.soundMuted;

    // 테마 변경: 실제 로드 + 윈도우 갱신
    if ("theme" in changes) {
      try {
        if (themeLoader.loadTheme) {
          activeTheme = themeLoader.loadTheme(changes.theme);
          if (_state.refreshTheme) _state.refreshTheme();
          if (typeof buildContextMenu === "function") buildContextMenu();
          // hit 윈도우로 새 테마 설정 푸시
          if (hitWin && !hitWin.isDestroyed()) {
            sendToHitWin("theme-config", themeLoader.getHitRendererConfig());
          }
          // 렌더러로 새 테마 설정 + 현재 SVG 새로고침
          if (win && !win.isDestroyed()) {
            win.webContents.send("theme-config", themeLoader.getRendererConfig ? themeLoader.getRendererConfig() : {});
            // 현재 state를 새 테마의 SVG로 재적용
            const cs = _state.getCurrentState();
            _state.applyState(cs, _state.getSvgOverride(cs));
          }
        }
      } catch (err) {
        console.warn("Clawd: theme reload failed:", err && err.message);
      }
    }

    // 2. Reactive side effects (mirror what the legacy setters / click handlers used to do).
    if ("hideBubbles" in changes) {
      try { syncPermissionShortcuts(); } catch (err) {
        console.warn("Clawd: syncPermissionShortcuts failed:", err && err.message);
      }
    }
    if ("bubbleFollowPet" in changes) {
      try { repositionFloatingBubbles(); } catch (err) {
        console.warn("Clawd: repositionFloatingBubbles failed:", err && err.message);
      }
    }

    // 3. Menu rebuild — only for menu-affecting keys to avoid thrashing on
    //    window position / mini state changes.
    for (const key of Object.keys(changes)) {
      if (MENU_AFFECTING_KEYS.has(key)) {
        try { rebuildAllMenus(); } catch (err) {
          console.warn("Clawd: rebuildAllMenus failed:", err && err.message);
        }
        break;
      }
    }

    // 4. Broadcast to all renderer windows for the future settings panel.
    try {
      for (const bw of BrowserWindow.getAllWindows()) {
        if (!bw.isDestroyed() && bw.webContents && !bw.webContents.isDestroyed()) {
          bw.webContents.send("settings-changed", { changes, snapshot: _settingsController.getSnapshot() });
        }
      }
    } catch (err) {
      console.warn("Clawd: settings-changed broadcast failed:", err && err.message);
    }
  });
}
wireSettingsSubscribers();

// ── IPC: settings panel write entry points ──
// Renderer-side callers (the future settings panel) use these. Menu/main code
// in this process calls _settingsController directly — no IPC round-trip.
ipcMain.handle("settings:get-snapshot", () => _settingsController.getSnapshot());
ipcMain.handle("settings:update", (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "settings:update payload must be { key, value }" };
  }
  return _settingsController.applyUpdate(payload.key, payload.value);
});
ipcMain.handle("settings:command", async (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "settings:command payload must be { action, payload }" };
  }
  return _settingsController.applyCommand(payload.action, payload.payload);
});
ipcMain.handle("settings:list-themes", () => {
  try {
    return themeLoader.discoverThemes().map(t => ({
      id: t.id, name: t.name, builtin: !!t.builtin,
    }));
  } catch (e) {
    return [];
  }
});
ipcMain.on("settings:open-theme-dir", () => {
  try {
    const { shell } = require("electron");
    const dir = themeLoader.ensureUserThemesDir && themeLoader.ensureUserThemesDir();
    if (dir) shell.openPath(dir);
  } catch {}
});

// ── Auto-updater — delegated to src/updater.js ──
const _updaterCtx = {
  get doNotDisturb() { return doNotDisturb; },
  get miniMode() { return _mini.getMiniMode(); },
  get lang() { return lang; },
  t, rebuildAllMenus, updateLog,
  showUpdateBubble: (payload) => showUpdateBubble(payload),
  hideUpdateBubble: () => hideUpdateBubble(),
  setUpdateVisualState: (kind) => _state.setUpdateVisualState(kind),
  applyState: (state, svgOverride) => applyState(state, svgOverride),
  resolveDisplayState: () => resolveDisplayState(),
  getSvgOverride: (state) => getSvgOverride(state),
  resetSoundCooldown: () => resetSoundCooldown(),
};
const _updater = require("./updater")(_updaterCtx);
const { setupAutoUpdater, checkForUpdates, getUpdateMenuItem, getUpdateMenuLabel } = _updater;

// ── Settings panel window ──
//
// Single-instance, non-modal, system-titlebar BrowserWindow that hosts the
// settings UI. Reuses ipcMain.handle("settings:get-snapshot" / "settings:update")
// already wired up for the controller. The renderer subscribes to
// settings-changed broadcasts so menu changes and panel changes stay in sync.
let settingsWindow = null;

function getSettingsWindowIcon() {
  // Don't pass an icon on macOS — the system uses the .app bundle icon.
  if (isMac) return undefined;
  if (isWin) {
    // Packaged build: extraResources puts icon.ico at process.resourcesPath.
    // Dev: read it from assets/. The files[] glob in package.json doesn't
    // include assets/icon.ico, so don't try to load it from __dirname/.. in
    // a packaged build — that path doesn't exist inside app.asar.
    return app.isPackaged
      ? path.join(process.resourcesPath, "icon.ico")
      : path.join(__dirname, "..", "assets", "icon.ico");
  }
  // Linux: build config points at assets/icons/, but those aren't shipped in
  // files[]. Skip the icon — the .desktop file (deb/AppImage) provides one.
  return undefined;
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const iconPath = getSettingsWindowIcon();
  const opts = {
    width: 800,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    show: false,
    frame: true,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    title: "Clawd Settings",
    backgroundColor: "#f5f5f7",
    webPreferences: {
      preload: path.join(__dirname, "preload-settings.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  };
  if (iconPath) opts.icon = iconPath;
  settingsWindow = new BrowserWindow(opts);
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
    settingsWindow.focus();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ── 말풍선 (speech bubble) ──
let speechWin = null;
let speechHideTimer = null;
const SPEECH_PHRASES = [
  // 코딩 팁
  "커밋 한 번 해두는 게 좋을 듯", "테스트는 돌렸어?", "타입 체크 통과?",
  "린터는 봤고?", "force push 조심해", "prod에서 --force 위험해",
  "rm -rf 하기 전에 한 번 더 확인", "브랜치 좀 정리하자", "PR 설명 자세히 써줘",
  "메모리 누수 없지?", "레이스 컨디션 주의", "데드락 조심",
  "에러 핸들링 다 했어?", "캐시 무효화 체크", "환경변수 맞아?",
  "롤백 플랜은 있고?", "커피 한 잔 할까", "쉬엄쉬엄 가자",
  // 해킹/보안 농담
  "sudo make me a sandwich", "; DROP TABLE users; --", "rm -rf / --no-preserve-root 금지",
  "0day 제보 받습니다", "buffer 크기 체크했어?", "CVE 하나 주세요",
  "/etc/shadow 왜 보려고", "패스워드 'password' 쓰면 안됨", "2FA 켜",
  "XSS는 escape부터", "SQL 인젝션 주의", "CSRF 토큰 있지?",
  "nmap 로컬에만", "와이파이 비번 hunter2", "가상머신에서 돌려",
  "shellshock 기억해?", "heartbleed 아직도 있대", "log4j 업데이트 됐어?",
  "세션 쿠키 HttpOnly", "JWT 시크릿 깃허브에 올리지마", "Bearer 토큰 유출 주의",
  "루트킷 심은 거 아니지?", "리버스쉘 금지", "스니핑 당하지 마",
  "netstat -tulpn 해봐", "pcap 분석 중", "방화벽 규칙 확인",
  "chmod 777 금지", "TLS 1.3 써", "SHA-256 이상으로",
];

function createSpeechWindow() {
  if (speechWin && !speechWin.isDestroyed()) return speechWin;
  const path = require("path");
  speechWin = new BrowserWindow({
    width: 250, height: 70,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    focusable: false, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  speechWin.setIgnoreMouseEvents(true);
  speechWin.loadFile(path.join(__dirname, "speech.html"));
  speechWin.on("closed", () => { speechWin = null; });
  ipcMain.on("speech-size", (_, { w, h }) => {
    if (!speechWin || speechWin.isDestroyed()) return;
    const b = speechWin.getBounds();
    speechWin.setBounds({ x: b.x, y: b.y, width: w, height: h });
  });
  return speechWin;
}

function _bumpSpeechStat() { try { sessionStats.speeches++; } catch {} }

// ── 말풍선 로그 ──
const speechLog = [];  // {ts, text}[]
const SPEECH_LOG_MAX = 300;
let speechLogWin = null;

function _broadcastSpeechLog() {
  if (speechLogWin && !speechLogWin.isDestroyed()) {
    try { speechLogWin.webContents.send("speech-log:changed"); } catch {}
  }
}
ipcMain.handle("speech-log:get", () => speechLog.slice());
ipcMain.on("speech-log:clear", () => { speechLog.length = 0; _broadcastSpeechLog(); });

function showSpeech(text, durationMs = 3000) {
  _bumpSpeechStat();
  speechLog.push({ ts: Date.now(), text });
  if (speechLog.length > SPEECH_LOG_MAX) speechLog.shift();
  _broadcastSpeechLog();
  if (!win || win.isDestroyed()) return;
  createSpeechWindow();
  const p = win.getBounds();
  // 말풍선 꼬리 tip(왼쪽에서 ~36px)이 Clawd 머리 중앙을 가리키도록
  const bw = 260, bh = 80;
  const targetX = p.x + Math.round(p.width / 2);  // Clawd 가로 중앙
  const bx = targetX - 36;  // tail 위치(왼쪽 28px + 꼬리 반폭 8)
  const by = Math.max(p.y + Math.round(p.height * 0.35) - bh, 0);  // Clawd 머리 근처
  speechWin.setBounds({ x: bx, y: by, width: bw, height: bh });
  speechWin.showInactive();
  speechWin.webContents.send("speech-set", text);
  if (speechHideTimer) clearTimeout(speechHideTimer);
  speechHideTimer = setTimeout(() => {
    if (speechWin && !speechWin.isDestroyed()) {
      speechWin.webContents.send("speech-hide");
      setTimeout(() => {
        if (speechWin && !speechWin.isDestroyed()) speechWin.hide();
      }, 350);
    }
  }, durationMs);
}

// ── 중력 낙하 ──
let gravityTimer = null;
let gravityVY = 0;
let shakeDizzyUntil = 0;
let gravityEnabled = false;

function startGravityFall() {
  if (!gravityEnabled) return;
  if (!win || win.isDestroyed()) return;
  if (gravityTimer) clearInterval(gravityTimer);
  gravityVY = 0;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const floorY = display.workArea.y + display.workArea.height - bounds.height - 8;
  if (bounds.y >= floorY) return;  // 이미 바닥에 있음
  gravityTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(gravityTimer); gravityTimer = null; return; }
    const b = win.getBounds();
    gravityVY += 1.8;
    let newY = Math.round(b.y + gravityVY);
    if (newY >= floorY) {
      newY = floorY;
      win.setBounds({ ...b, y: newY });
      clearInterval(gravityTimer); gravityTimer = null;
      // 어지러운 상태 계속이면 ERROR 유지, 아니면 IDLE
      if (Date.now() < shakeDizzyUntil) {
        // 이미 error 애니메이션 표시중
      } else {
        try { setState("idle"); } catch (e) {}
      }
      if (typeof showSpeech === "function") showSpeech("아야…", 1500);
      syncHitWin();
      return;
    }
    win.setBounds({ ...b, y: newY });
    syncHitWin();
  }, 16);
}

// ── 🎯 일일 목표 ──
let dailyPomodoroGoal = 4;
let dailyPomodoroReached = false;
let dailyGoalDate = new Date().toDateString();

function checkDailyGoal() {
  const today = new Date().toDateString();
  if (today !== dailyGoalDate) {
    dailyGoalDate = today;
    dailyPomodoroReached = false;
    sessionStats.pomodoros = 0;
  }
  if (!dailyPomodoroReached && sessionStats.pomodoros >= dailyPomodoroGoal) {
    dailyPomodoroReached = true;
    showSpeech(`🎯 오늘 목표 ${dailyPomodoroGoal}회 달성!`, 6000);
    if (win && !win.isDestroyed()) win.webContents.send("celebrate");
    if (win) win.webContents.send("play-sound", "complete");
  }
}

// ── 🔔 시스템 Toast 알림 ──
function showSystemNotification(title, body) {
  try {
    const { Notification } = require("electron");
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: false }).show();
  } catch {}
}

// ── 🏆 에이전트 배틀 중계 ──
let lastBattleCommentaryAt = 0;
setInterval(() => {
  try {
    const activeAgents = new Set();
    for (const [, s] of _state.sessions) {
      if (s && s.agentId && s.state !== "idle") activeAgents.add(s.agentId);
    }
    if (activeAgents.size >= 2 && Date.now() - lastBattleCommentaryAt > 60000) {
      lastBattleCommentaryAt = Date.now();
      const names = Array.from(activeAgents).join(" vs ");
      const lines = [
        `${names} 붙었다!`,
        `${activeAgents.size}명 동시 작업 중`,
        `멀티 에이전트 레이스`,
        `${names} 실시간 대결`,
      ];
      showSpeech(lines[Math.floor(Math.random() * lines.length)], 4000);
    }
  } catch {}
}, 5000);

// ── 📝 커스텀 대사 (prefs에서 읽음) ──
function getCustomPhrases() {
  try {
    const s = _settingsController.getSnapshot();
    return Array.isArray(s.customPhrases) ? s.customPhrases : [];
  } catch { return []; }
}

// ── 🎨 색상 커스터마이즈 ──
function getCustomColor() {
  try {
    const s = _settingsController.getSnapshot();
    return typeof s.clawdColor === "string" ? s.clawdColor : null;
  } catch { return null; }
}

// ── 🎵 사운드 이벤트 ──
function playSoundEvent(name) {
  try {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("play-sound-event", name);
  } catch {}
}

// ── 세션 통계 ──
const sessionStats = {
  startedAt: Date.now(),
  toolCalls: 0,
  errors: 0,
  thinks: 0,
  pomodoros: 0,
  speeches: 0,
};

function bumpStat(key, n = 1) {
  if (sessionStats[key] !== undefined) sessionStats[key] += n;
}

function getStatsSummary() {
  const mins = Math.round((Date.now() - sessionStats.startedAt) / 60000);
  return `⏱ ${mins}분  🔧 도구 ${sessionStats.toolCalls}  ❌ 에러 ${sessionStats.errors}  💭 생각 ${sessionStats.thinks}  🍅 포모도로 ${sessionStats.pomodoros}  💬 말 ${sessionStats.speeches}`;
}

// ── 긴 생각 감지: 10분 넘게 thinking이면 "괜찮아?" ──
let lastThinkingStartedAt = 0;
setInterval(() => {
  try {
    const cs = _state.getCurrentState();
    if (cs === "thinking") {
      if (lastThinkingStartedAt === 0) lastThinkingStartedAt = Date.now();
      else if (Date.now() - lastThinkingStartedAt > 10 * 60 * 1000) {
        showSpeech("벌써 10분째… 괜찮아?", 4000);
        lastThinkingStartedAt = Date.now();  // 재트리거 막기 위해 리셋
      }
    } else {
      lastThinkingStartedAt = 0;
    }
  } catch {}
}, 30000);

// ── 파티클 축하 (attention 전환 시) ──
let lastAttentionAt = 0;
setInterval(() => {
  try {
    const cs = _state.getCurrentState();
    const now = Date.now();
    if (cs === "attention" && now - lastAttentionAt > 3000) {
      lastAttentionAt = now;
      if (win && !win.isDestroyed()) {
        win.webContents.send("celebrate");
      }
    }
  } catch {}
}, 500);

// ── 포모도로 타이머 ──
let pomodoroEndsAt = 0;
let pomodoroTimer = null;

function startPomodoro(minutes = 25) {
  if (pomodoroTimer) clearTimeout(pomodoroTimer);
  pomodoroEndsAt = Date.now() + minutes * 60 * 1000;
  try { setState("working", "clawd-working-typing.svg"); } catch {}
  showSpeech(`${minutes}분 집중 시작`, 3000);
  pomodoroTimer = setTimeout(() => {
    pomodoroTimer = null;
    pomodoroEndsAt = 0;
    bumpStat("pomodoros");
    checkDailyGoal();
    try { setState("attention", "clawd-happy.svg"); } catch {}
    showSpeech("끝! 휴식 시간~", 5000);
    showSystemNotification("🍅 포모도로 완료", `총 ${sessionStats.pomodoros}회 완료`);
    try {
      if (win) win.webContents.send("play-sound", "complete");
    } catch {}
  }, minutes * 60 * 1000);
}

function cancelPomodoro() {
  if (pomodoroTimer) { clearTimeout(pomodoroTimer); pomodoroTimer = null; }
  pomodoroEndsAt = 0;
  try { setState("idle"); } catch {}
  showSpeech("타이머 취소", 2000);
}

// 포모도로 남은 시간 주기 체크 (5분/1분 남았을 때 알림)
let pomodoroLastNotifyMin = -1;
setInterval(() => {
  if (!pomodoroEndsAt) { pomodoroLastNotifyMin = -1; return; }
  const remainMin = Math.max(0, Math.ceil((pomodoroEndsAt - Date.now()) / 60000));
  if (remainMin === 5 && pomodoroLastNotifyMin !== 5) {
    pomodoroLastNotifyMin = 5;
    showSpeech("5분 남았어", 3000);
  } else if (remainMin === 1 && pomodoroLastNotifyMin !== 1) {
    pomodoroLastNotifyMin = 1;
    showSpeech("1분 남았어!", 3000);
  }
}, 20000);

// ── 더블클릭 쓰다듬기 + 미니게임 (먹이 주기) ──
let petDoubleClickCount = 0;
let petDoubleClickResetTimer = null;
ipcMain.on("pet-double-click", () => {
  try { setState("attention", "clawd-happy.svg"); } catch {}
  petDoubleClickCount++;
  if (petDoubleClickResetTimer) clearTimeout(petDoubleClickResetTimer);
  petDoubleClickResetTimer = setTimeout(() => { petDoubleClickCount = 0; }, 5000);

  if (petDoubleClickCount >= 5) {
    showSpeech("배불러! 그만 그만~", 3000);
    if (win && !win.isDestroyed()) win.webContents.send("celebrate");
    petDoubleClickCount = 0;
  } else {
    const phrases = ["냠냠", "헤헤", "좋아", "고마워", "💕", "ㅎㅎ", "또!"];
    showSpeech(phrases[Math.floor(Math.random() * phrases.length)], 2000);
    if (win && !win.isDestroyed()) win.webContents.send("mini-feed");
  }
});

// ── 커서 따라가기 ──
let followCursorEnabled = false;

setInterval(() => {
  if (!followCursorEnabled) return;
  if (!win || win.isDestroyed()) return;
  if (dragLocked || gravityTimer) return;
  if (shakeDizzyUntil > Date.now()) return;

  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const dx = cursor.x - cx;
  const dy = cursor.y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 100) return;  // 이미 가까우면 정지

  const speed = 3;
  const nx = Math.round(b.x + (dx / dist) * speed);
  const ny = Math.round(b.y + (dy / dist) * speed);
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  const clampedX = Math.max(wa.x, Math.min(wa.x + wa.width - b.width, nx));
  const clampedY = Math.max(wa.y, Math.min(wa.y + wa.height - b.height, ny));
  win.setBounds({ ...b, x: clampedX, y: clampedY });
  syncHitWin();
  // 따라가는 중엔 walking 애니 + facing
  try { setState("working", "clawd-crab-walking.svg"); } catch {}
  try { win.webContents.send("set-facing", dx > 0 ? "right" : "left"); } catch {}
}, 40);

// ── 클로드 이벤트 기반 말풍선 ──
const EVENT_SPEECHES = {
  thinking: ["음 뭐지", "잠깐", "생각 중", "흠", "어디 보자", "으음"],
  working: ["오 뭐 만드는 거야", "작업 중이네", "재밌겠다", "오호", "흠 뭐 할까"],
  error: ["어? 망했네", "뭐지 이거", "아이고", "에러났나봐", "괜찮아 될 거야"],
  attention: ["오 끝났네", "다 됐어", "잘했어", "완성이다", "굿", "수고했어"],
  notification: ["저기", "이거 봐봐", "잠깐", "응?"],
  sweeping: ["정리 좀 할게", "깨끗하게", "싹싹"],
  juggling: ["바쁘네", "여러 개네", "오 한꺼번에"],
  carrying: ["영차", "옮기는 중", "어디로 가지"],
};

function speakForState(state) {
  if (smartSpeechEnabled) {
    smartSpeakForState(state);
    return;
  }
  const list = EVENT_SPEECHES[state];
  if (!list) return;
  if (Math.random() > 0.5) return;
  const phrase = list[Math.floor(Math.random() * list.length)];
  showSpeech(phrase, 2500);
}

// ── 🤖 AI 말풍선 (claude CLI 사용) ──
let smartSpeechEnabled = true;
let smartSpeechPending = false;
let smartSpeechLastCall = 0;

function smartSpeak(context, fallback) {
  const now = Date.now();
  // 이미 AI 호출 진행 중이면 fallback만 바로 보여주고 끝
  if (smartSpeechPending) {
    if (fallback) showSpeech(fallback, 2500);
    return;
  }
  // 쿨다운: 10초
  if (now - smartSpeechLastCall < 10000) {
    if (fallback) showSpeech(fallback, 2500);
    return;
  }
  smartSpeechPending = true;
  smartSpeechLastCall = now;

  const { spawn } = require("child_process");
  const prompt = `너는 Clawd, 사용자 데스크톱에 사는 작고 귀여운 픽셀 게 친구야. 딱딱한 AI 아니라 그냥 옆에 있는 친구처럼 편하게 말해. "${context}" 이런 느낌 있어. 이걸 보고 한국어로 짧게 한 마디 친구처럼 던져. 반말, 이모지나 기호 없이 자연스럽게, 20자 이내. 같은 상황이어도 매번 다르게 말해. 답만 적고 설명하지 마.`;
  const [cmd, args] = buildClaudeCliSpawn(prompt);
  const child = spawn(cmd, args, { timeout: 15000 });
  let out = "";
  child.stdout.on("data", d => out += d.toString());
  let err = "";
  child.stderr.on("data", d => err += d.toString());
  child.on("error", () => {
    smartSpeechPending = false;
    if (fallback) showSpeech(fallback, 2500);
  });
  child.on("close", () => { if (out.trim()) markClawdSessionInitialized();
    smartSpeechPending = false;
    const text = (out || "").trim().split("\n").filter(l => l.trim()).pop();
    const clean = text ? text.replace(/^["'「『]+|["'」』.]+$/g, "").slice(0, 50) : "";
    if (clean) showSpeech(clean, 4000);
    else if (fallback) showSpeech(fallback, 2500);
  });
}

// Clawd Map에서 추적 중인 활성 non-headless 세션과 그 agentId 반환
function getActiveUserSession() {
  let best = null;
  try {
    for (const [sid, s] of _state.sessions) {
      if (!s || s.headless) continue;
      if (!best || (s.updatedAt || 0) > (best.updatedAt || 0)) {
        best = { sessionId: sid, ...s };
      }
    }
  } catch {}
  return best;
}

// Windows 네이티브 claude.exe 경로 자동 감지 (캐시)
let _winClaudeExeCache = null;
function findWindowsClaudeExe() {
  if (_winClaudeExeCache !== null) return _winClaudeExeCache || null;
  if (process.platform !== "win32") { _winClaudeExeCache = ""; return null; }
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
    path.join(os.homedir(), "AppData", "Local", "Programs", "claude", "claude.exe"),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) { _winClaudeExeCache = c; return c; } } catch {}
  }
  _winClaudeExeCache = "";
  return null;
}

// Clawd 전용 영구 Claude 세션 UUID (한 번 만들고 계속 재사용)
let _clawdSessionId = null;
let _clawdSessionInitialized = false;
function getClawdSessionId() {
  if (_clawdSessionId) return _clawdSessionId;
  try {
    const s = _settingsController.getSnapshot();
    if (s && typeof s.clawdChatSessionId === "string" && s.clawdChatSessionId) {
      _clawdSessionId = s.clawdChatSessionId;
      _clawdSessionInitialized = !!s.clawdChatSessionInitialized;
      return _clawdSessionId;
    }
  } catch {}
  const { randomBytes } = require("crypto");
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  _clawdSessionId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  _clawdSessionInitialized = false;
  try {
    _settingsController.applyUpdate("clawdChatSessionId", _clawdSessionId);
    _settingsController.applyUpdate("clawdChatSessionInitialized", false);
  } catch {}
  return _clawdSessionId;
}

function markClawdSessionInitialized() {
  if (_clawdSessionInitialized) return;
  _clawdSessionInitialized = true;
  try { _settingsController.applyUpdate("clawdChatSessionInitialized", true); } catch {}
}

// Claude CLI spawn
// 첫 호출: --session-id <uuid> (세션 생성)
// 이후 호출: -r <uuid> (기존 세션 이어받기)
function buildClaudeCliSpawn(prompt) {
  const sid = getClawdSessionId();
  const sessionFlag = _clawdSessionInitialized
    ? ["-r", sid]
    : ["--session-id", sid];
  // --bare 제거 이유: keychain read 스킵돼서 OAuth 로그인 안 읽음 → 인증 실패
  // 대신 state.js의 isClawdOwnSession 필터로 훅 재귀 호출 차단 중
  // --permission-mode bypassPermissions: 권한 프롬프트 안 띄움
  const baseArgs = ["--model", "haiku",
    "--permission-mode", "bypassPermissions",
    ...sessionFlag, "-p", prompt];
  if (process.platform === "win32") {
    const exe = findWindowsClaudeExe();
    if (exe) return [exe, baseArgs];
    const distro = findWslClaudeDistro() || "Ubuntu";
    return ["wsl.exe", ["-d", distro, "--", "/home/serize/.local/bin/claude", ...baseArgs]];
  }
  return ["claude", baseArgs];
}

let _wslClaudeDistroCache = null;
function findWslClaudeDistro() {
  if (_wslClaudeDistroCache !== null) return _wslClaudeDistroCache || null;
  try {
    const { execSync } = require("child_process");
    const out = execSync("wsl.exe -l -q", { encoding: "utf16le", timeout: 3000 }).toString();
    const distros = out.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.includes("docker"));
    for (const d of distros) {
      try {
        execSync(`wsl.exe -d ${d} -- bash -c 'command -v claude >/dev/null 2>&1 || test -x $HOME/.local/bin/claude'`,
          { timeout: 3000 });
        _wslClaudeDistroCache = d;
        return d;
      } catch {}
    }
  } catch {}
  _wslClaudeDistroCache = "";
  return null;
}

// WSL distro + 사용자 자동 감지 → 가능한 UNC 경로 후보 반환
let _wslHomeCache = null;
function getWslHomes() {
  if (_wslHomeCache) return _wslHomeCache;
  const results = [];
  try {
    const { execSync } = require("child_process");
    // 실행 중인 WSL distro 목록 (verbose)
    let out = "";
    try {
      out = execSync("wsl.exe -l -q", { encoding: "utf16le", timeout: 3000 }).toString();
    } catch { out = ""; }
    const distros = out.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.includes("docker"));
    for (const distro of distros.length ? distros : ["Ubuntu"]) {
      // 각 distro에서 $HOME 확인
      let home = "";
      try {
        home = execSync(`wsl.exe -d ${distro} -- bash -c 'echo $HOME'`, { timeout: 3000 }).toString().trim();
      } catch {}
      if (home) {
        const winPath = `\\\\wsl.localhost\\${distro}${home.replace(/\//g, "\\")}`;
        results.push(winPath);
      }
    }
  } catch {}
  _wslHomeCache = results;
  return results;
}

// 에이전트별 transcript 디렉토리 (Windows 홈 + 모든 WSL distro 홈 모두 탐색)
function getTranscriptBases(agentId) {
  const path = require("path");
  const os = require("os");
  const WIN_HOME = os.homedir();
  const wslHomes = process.platform === "win32" ? getWslHomes() : [];
  const homes = [WIN_HOME, ...wslHomes];

  const subdirs = {
    "claude-code": [[".claude", "projects"]],
    "codex":       [[".codex", "sessions"]],
    "gemini-cli":  [[".gemini", "sessions"], [".gemini"]],
    "copilot-cli": [[".copilot"]],
    "opencode":    [[".config", "opencode"], ["AppData", "Roaming", "opencode"]],
    "cursor-agent":[["AppData", "Roaming", "Cursor", "logs"], ["AppData", "Roaming", "Cursor", "User", "History"]],
    "kiro-cli":    [[".kiro"]],
    "codebuddy":   [[".codebuddy"]],
    "vscode-agent":[["AppData", "Roaming", "Code", "logs"]],
  };
  const want = subdirs[agentId] || subdirs["claude-code"];
  const result = [];
  for (const home of homes) {
    for (const parts of want) {
      // WSL UNC 경로면 \ 구분자, 일반 Windows면 path.join
      if (home.startsWith("\\\\")) {
        result.push(home + "\\" + parts.join("\\"));
      } else {
        result.push(path.join(home, ...parts));
      }
    }
  }
  return result;
}

// 가장 최근 transcript JSONL 찾기 (agent에 맞는 디렉토리만)
function findLatestTranscript() {
  const fs = require("fs");
  const path = require("path");
  const active = getActiveUserSession();
  const agentId = active && active.agentId || "claude-code";
  const targetSid = active && active.sessionId;

  const bases = getTranscriptBases(agentId);
  let best = null;
  let bestTime = 0;

  function isClawdOwnTranscript(file) {
    // 파일 앞 500자에서 Clawd 프롬프트 시그니처 찾기 (우리가 발생시킨 -p 호출)
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(2000);
      fs.readSync(fd, buf, 0, 2000, 0);
      fs.closeSync(fd);
      const head = buf.toString("utf8");
      return head.includes("너는 Clawd") || head.includes("픽셀 게 펫") || head.includes("픽셀 게 친구");
    } catch { return false; }
  }

  function walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.endsWith(".jsonl")) continue;
      // Claude-code 경로: 파일명이 session id — 활성 세션만
      if (agentId === "claude-code" && targetSid) {
        const sid = entry.replace(/\.jsonl$/, "");
        if (sid !== targetSid) continue;
      }
      if (st.size < 3000) continue;
      // Clawd 자신의 -p 호출로 생성된 JSONL 제외
      if (isClawdOwnTranscript(full)) continue;
      if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = full; }
    }
  }
  for (const base of bases) walk(base);
  return { file: best, agentId };
}

// JSONL에서 마지막 user 메시지 + 마지막 assistant 메시지 추출
// agentId별로 포맷이 달라서 분기
function readLastExchange(file, agentId) {
  try {
    const fs = require("fs");
    const content = fs.readFileSync(file, "utf8");
    const lines = content.trim().split("\n");
    let lastUser = "", lastAssistant = "";

    for (let i = lines.length - 1; i >= 0 && (!lastUser || !lastAssistant); i--) {
      let obj; try { obj = JSON.parse(lines[i]); } catch { continue; }

      if (agentId === "codex") {
        if (obj.type === "event_msg") {
          const t = obj.text || (obj.payload && obj.payload.text) || "";
          if (obj.subtype === "user_message" && t && !lastUser) lastUser = t;
          else if (obj.subtype === "agent_message" && t && !lastAssistant) lastAssistant = t;
        }
        continue;
      }

      if (agentId === "gemini-cli") {
        // Gemini 세션 로그: { role: "user"|"model", parts: [{text}] } 형태 (추정)
        const role = obj.role || obj.type;
        const text = (obj.text) || (Array.isArray(obj.parts) ? obj.parts.map(p => p.text || "").join(" ") : "") || obj.content;
        if (!text) continue;
        if ((role === "user" || role === "User") && !lastUser) lastUser = text;
        else if ((role === "model" || role === "assistant" || role === "Gemini") && !lastAssistant) lastAssistant = text;
        continue;
      }

      if (agentId === "opencode" || agentId === "copilot-cli" || agentId === "kiro-cli" || agentId === "codebuddy") {
        // 일반적 포맷 시도: role/content 있는 건 다 시도
        const role = obj.role || obj.type;
        const text = typeof obj.content === "string" ? obj.content
          : Array.isArray(obj.content) ? obj.content.filter(c => c.text).map(c => c.text).join(" ")
          : obj.text || obj.message || "";
        if (!text) continue;
        if (role === "user" && !lastUser) lastUser = text;
        else if ((role === "assistant" || role === "agent") && !lastAssistant) lastAssistant = text;
        continue;
      }

      // claude-code 형식 (기본)
      const role = obj.type || obj.role;
      const msg = obj.message;
      if (!msg) continue;
      const contentStr = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(c => c.type === "text").map(c => c.text).join(" ")
          : "";
      if (!contentStr) continue;
      if (role === "user" && !lastUser) lastUser = contentStr;
      else if (role === "assistant" && !lastAssistant) lastAssistant = contentStr;
    }
    return { user: lastUser.slice(-800), assistant: lastAssistant.slice(-800) };
  } catch { return null; }
}

// 대화 기반 버디 코멘트
let conversationCommentPending = false;
function speakAboutConversation() {
  if (conversationCommentPending) return;
  const res = findLatestTranscript();
  if (!res || !res.file) { showSpeech("대화 기록 못 찾겠어", 2500); return; }
  const ex = readLastExchange(res.file, res.agentId);
  if (!ex || (!ex.user && !ex.assistant)) { showSpeech("대화가 비어있네", 2500); return; }
  conversationCommentPending = true;

  const prompt = `너는 친구가 AI랑 대화하는 걸 옆에서 지켜보는 귀여운 픽셀 게 펫 Clawd야. AI 말투 쓰지 말고 그냥 친구가 옆에서 한 마디 던지듯 반응해.\n\n사용자: ${ex.user || "(없음)"}\nAI 답변: ${ex.assistant || "(없음)"}\n\n이 대화에 대해 친구처럼 한 마디 해. 30자 이내, 반말, 이모지/따옴표 없이. 답만 적어.`;

  const { spawn } = require("child_process");
  const [cmd, args] = buildClaudeCliSpawn(prompt);
  // 조용히 대기 후 결과만 표시 (thinking 플레이스홀더 없음)
  const child = spawn(cmd, args, { timeout: 60000, windowsHide: true });
  let out = "", err = "";
  child.stdout.on("data", d => out += d.toString());
  child.stderr.on("data", d => err += d.toString());
  child.on("close", () => { if (out.trim()) markClawdSessionInitialized();
    conversationCommentPending = false;
    const text = (out || "").trim().split("\n").filter(l => l.trim()).pop();
    const clean = text ? text.replace(/^["'「『]+|["'」』.]+$/g, "").slice(0, 60) : "";
    if (clean) showSpeech(clean, 5000);
    else showSpeech(err.trim().slice(-40) || "음 잘 모르겠네", 4000);
  });
  child.on("error", (e) => {
    conversationCommentPending = false;
    showSpeech(`실패: ${e.message}`, 3000);
  });
}

// AI 모드에서는 Claude가 답변 다 끝낸 시점(attention = Stop)에만 반응
function smartSpeakForState(state) {
  if (state === "attention") {
    speakAboutConversation();
  }
  // 다른 상태 (thinking/working/error 등)는 AI 모드에서 말하지 않음
  // → 중간 업데이트마다 말하는 것 방지
}

// 상태 전환 감지 → 이벤트 말풍선 + 통계
let _lastStateForSpeech = "idle";
setInterval(() => {
  try {
    const cur = _state.getCurrentState();
    if (cur && cur !== _lastStateForSpeech) {
      speakForState(cur);
      // 통계
      if (cur === "working") bumpStat("toolCalls");
      else if (cur === "error") {
        bumpStat("errors");
        showSystemNotification("Clawd — 에러", "Claude Code 세션에서 에러 발생");
      } else if (cur === "thinking") bumpStat("thinks");
      _lastStateForSpeech = cur;
    }
  } catch {}
}, 500);

// ── 자유 걷기 ──
let walkEnabled = false;
let walkMode = "stop";  // "left" | "right" | "stop"
let walkNextChange = Date.now();

function pickWalkMode() {
  const r = Math.random();
  if (r < 0.35) return "left";
  if (r < 0.7) return "right";
  return "stop";
}

let walking = false;

setInterval(() => {
  if (!walkEnabled) return;
  if (!win || win.isDestroyed()) return;
  if (dragLocked) return;
  if (gravityTimer) return;
  if (shakeDizzyUntil > Date.now()) return;
  // 다른 동작(thinking/typing/building 등) 중이면 걷기 멈춤
  // walking이 true면 우리가 working 상태를 걷기용으로 쓰고 있음 → 계속 진행
  const cs = _state.getCurrentState();
  const cSvg = _state.getCurrentSvg();
  if (cs !== "idle" && !(walking && cSvg === "clawd-crab-walking.svg")) {
    walking = false;
    return;
  }

  const now = Date.now();
  if (now > walkNextChange) {
    walkMode = pickWalkMode();
    // 짧게: 1~2.5초, 길게: 2.5~5초 섞어서
    walkNextChange = now + 1000 + Math.random() * 4000;
  }

  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  const speed = 2;
  let walkDirection = 0;
  if (walkMode === "left") walkDirection = -1;
  else if (walkMode === "right") walkDirection = 1;
  let nx = b.x + speed * walkDirection;

  if (nx <= wa.x) { nx = wa.x; walkMode = "right"; }
  else if (nx + b.width >= wa.x + wa.width) {
    nx = wa.x + wa.width - b.width;
    walkMode = "left";
  }

  if (nx !== b.x) {
    win.setBounds({ ...b, x: nx });
    syncHitWin();
    if (!walking) {
      try { setState("working", "clawd-crab-walking.svg"); walking = true; } catch {}
    }
    // 방향에 따라 스프라이트 좌우 반전
    try { win.webContents.send("set-facing", walkDirection > 0 ? "right" : "left"); } catch {}
  } else {
    if (walking) {
      try { setState("idle"); } catch {}
      try { win.webContents.send("set-facing", "left"); } catch {}
      walking = false;
    }
  }
}, 50);

// ── 글로벌 단축키: Ctrl+Shift+Space = Clawd에게 AI 질문 ──
app.whenReady().then(() => {
  try {
    globalShortcut.register("CommandOrControl+Shift+Space", () => {
      if (smartSpeechEnabled) {
        smartSpeak("사용자가 Ctrl+Shift+Space로 너한테 말 걸었어. 친근하게 답해", "불렀어?");
      } else {
        const phrases = ["불렀어?", "뭐해?", "여기있어", "응?"];
        showSpeech(phrases[Math.floor(Math.random() * phrases.length)], 3000);
      }
    });
  } catch {}
});

// ── 최근 커밋 말하기 ──
function speakRecentCommit() {
  const { exec } = require("child_process");
  const cmd = process.platform === "win32"
    ? 'git -C "%cd%" log -1 --pretty=%%s 2>nul'
    : 'cd ~ && git log -1 --pretty=%s 2>/dev/null';
  exec(cmd, { timeout: 3000 }, (err, stdout) => {
    const msg = (stdout || "").trim().slice(0, 40);
    showSpeech(msg ? `최근: "${msg}"` : "최근 커밋 없음", 4500);
  });
}

// 어지러움 해제 체크
setInterval(() => {
  if (shakeDizzyUntil > 0 && Date.now() > shakeDizzyUntil) {
    shakeDizzyUntil = 0;
    try { setState("idle"); } catch (e) {}
  }
}, 500);

// 주기적 랜덤 대사 — AI 활동 있으면 스킵, 아니면 2분마다 20% 확률로만
setInterval(() => {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (smartSpeechEnabled) {
    if (smartSpeechPending || conversationCommentPending) return;
    if (Date.now() - smartSpeechLastCall < 30000) return;
  }
  if (speechWin && !speechWin.isDestroyed() && speechWin.isVisible()) return;
  if (Math.random() < 0.3) {
    const custom = getCustomPhrases();
    const pool = custom.length ? SPEECH_PHRASES.concat(custom) : SPEECH_PHRASES;
    const phrase = pool[Math.floor(Math.random() * pool.length)];
    showSpeech(phrase, 3500);
  }
}, 60000);

// Clawd 창 이동 시 말풍선 따라가기
function syncSpeechPosition() {
  if (!speechWin || speechWin.isDestroyed() || !speechWin.isVisible()) return;
  if (!win || win.isDestroyed()) return;
  const p = win.getBounds();
  const b = speechWin.getBounds();
  const targetX = p.x + Math.round(p.width / 2);
  speechWin.setBounds({
    x: targetX - 36,
    y: Math.max(p.y + Math.round(p.height * 0.35) - b.height, 0),
    width: b.width, height: b.height,
  });
}

function createWindow() {
  // Read everything from the settings controller. The mirror caches above
  // (lang/showTray/etc.) were already initialized at module-load time, so
  // here we just need the position/mini fields plus the legacy size migration.
  const prefs = _settingsController.getSnapshot();
  // Legacy S/M/L → P:N migration. Only kicks in for prefs files that haven't
  // been touched since v0; new files always store the proportional form.
  if (SIZES[prefs.size]) {
    const wa = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
    const px = SIZES[prefs.size].width;
    const ratio = Math.round(px / wa.width * 100);
    const migrated = `P:${Math.max(1, Math.min(75, ratio))}`;
    _settingsController.applyUpdate("size", migrated); // subscriber updates currentSize mirror
  }
  // macOS: apply dock visibility (default visible — but persisted state wins).
  if (isMac) {
    applyDockVisibility();
  }
  const size = getCurrentPixelSize();

  // Restore saved position, or default to bottom-right of primary display.
  // Prefs file always exists in the new architecture (defaults are hydrated
  // by prefs.load()), so the "no prefs" branch from the legacy code is gone —
  // a fresh install gets x=0, y=0 from defaults, and we treat that as "place
  // bottom-right" via the explicit zero check below.
  let startX, startY;
  if (prefs.miniMode) {
    const miniPos = _mini.restoreFromPrefs(prefs, size);
    startX = miniPos.x;
    startY = miniPos.y;
  } else if (prefs.positionSaved) {
    const clamped = clampToScreen(prefs.x, prefs.y, size.width, size.height);
    startX = clamped.x;
    startY = clamped.y;
  } else {
    const workArea = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
    startX = workArea.x + workArea.width - size.width - 20;
    startY = workArea.y + workArea.height - size.height - 20;
  }

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
    ...(isMac ? { type: "panel", roundedCorners: false } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
      additionalArguments: [
        "--theme-config=" + JSON.stringify(themeLoader.getRendererConfig()),
      ],
    },
  });

  win.setFocusable(false);

  // Watchdog (Linux only): prevent accidental window close.
  // render-process-gone is handled by the global crash-recovery handler below.
  // On macOS/Windows the WM handles window lifecycle differently.
  if (isLinux) {
    win.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        if (!win.isVisible()) win.showInactive();
      }
    });
    win.on("unresponsive", () => {
      if (isQuitting) return;
      console.warn("Clawd: renderer unresponsive — reloading");
      win.webContents.reload();
    });
  }

  if (isWin) {
    // Windows: use pop-up-menu level to stay above taskbar/shell UI
    win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }
  win.loadFile(path.join(__dirname, "index.html"));
  win.showInactive();
  // Linux WMs may reset skipTaskbar after showInactive — re-apply explicitly
  if (isLinux) win.setSkipTaskbar(true);
  // macOS: apply after showInactive() — it resets NSWindowCollectionBehavior
  reapplyMacVisibility();

  // macOS: startup-time dock state can be overridden during app/window activation.
  // Re-apply once on next tick so persisted showDock reliably takes effect.
  if (isMac) {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      applyDockVisibility();
    }, 0);
  }

  buildContextMenu();
  if (!isMac || showTray) createTray();
  ensureContextMenuOwner();



  // ── Create input window (hitWin) — small rect over hitbox, receives all pointer events ──
  {
    const initBounds = win.getBounds();
    const initHit = getHitRectScreen(initBounds);
    const hx = Math.round(initHit.left), hy = Math.round(initHit.top);
    const hw = Math.round(initHit.right - initHit.left);
    const hh = Math.round(initHit.bottom - initHit.top);

    hitWin = new BrowserWindow({
      width: hw, height: hh, x: hx, y: hy,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      focusable: !isLinux,  // KEY EXPERIMENT: allow activation to avoid WS_EX_NOACTIVATE input routing bugs (Windows-only issue)
      webPreferences: {
        preload: path.join(__dirname, "preload-hit.js"),
        backgroundThrottling: false,
        additionalArguments: [
          "--hit-theme-config=" + JSON.stringify(themeLoader.getHitRendererConfig()),
        ],
      },
    });
    // setShape: native hit region, no per-pixel alpha dependency.
    // hitWin has no visual content — clipping is irrelevant.
    hitWin.setShape([{ x: 0, y: 0, width: hw, height: hh }]);
    hitWin.setIgnoreMouseEvents(false);  // PERMANENT — never toggle
    if (isMac) hitWin.setFocusable(false);
    hitWin.showInactive();
    // Linux WMs may reset skipTaskbar after showInactive — re-apply explicitly
    if (isLinux) hitWin.setSkipTaskbar(true);
    if (isWin) {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    // macOS: apply after showInactive() — it resets NSWindowCollectionBehavior
    reapplyMacVisibility();
    hitWin.loadFile(path.join(__dirname, "hit.html"));
    if (isWin) guardAlwaysOnTop(hitWin);

    // Event-level safety net for position sync
    const syncFloatingWindows = () => {
      syncHitWin();
      if (bubbleFollowPet) repositionFloatingBubbles();
      else repositionUpdateBubble();
      syncSpeechPosition();
    };
    win.on("move", syncFloatingWindows);
    win.on("resize", syncFloatingWindows);

    // Send initial state to hitWin once it's ready
    hitWin.webContents.on("did-finish-load", () => {
      sendToHitWin("theme-config", themeLoader.getHitRendererConfig());
      if (themeReloadInProgress) return;
      syncHitStateAfterLoad();
    });

    // Crash recovery for hitWin
    hitWin.webContents.on("render-process-gone", (_event, details) => {
      console.error("hitWin renderer crashed:", details.reason);
      hitWin.webContents.reload();
    });
  }

  ipcMain.on("show-context-menu", showPetContextMenu);

  ipcMain.on("move-window-by", (event, dx, dy) => {
    if (_mini.getMiniMode() || _mini.getMiniTransitioning()) return;
    const { x, y } = win.getBounds();
    const size = getCurrentPixelSize();
    // During drag: allow free movement across screens, only prevent
    // the pet from going completely off-screen (keep 25% visible).
    const newX = x + dx, newY = y + dy;
    const looseClamped = looseClampToDisplays(newX, newY, size.width, size.height);
    win.setBounds({ ...looseClamped, width: size.width, height: size.height });
    syncHitWin();
    if (bubbleFollowPet) repositionFloatingBubbles();
  });

  ipcMain.on("pause-cursor-polling", () => { idlePaused = true; });
  ipcMain.on("resume-from-reaction", () => {
    idlePaused = false;
    if (_mini.getMiniTransitioning()) return;
    sendToRenderer("state-change", _state.getCurrentState(), _state.getCurrentSvg());
  });

  ipcMain.on("drag-lock", (event, locked) => {
    dragLocked = !!locked;
    if (locked) mouseOverPet = true;
  });

  // Reaction relay: hitWin → main → renderWin
  ipcMain.on("start-drag-reaction", () => sendToRenderer("start-drag-reaction"));
  ipcMain.on("end-drag-reaction", () => sendToRenderer("end-drag-reaction"));
  ipcMain.on("play-click-reaction", (_, svg, duration) => {
    sendToRenderer("play-click-reaction", svg, duration);
  });

  ipcMain.on("drag-end", () => {
    if (!_mini.getMiniMode() && !_mini.getMiniTransitioning()) {
      checkMiniModeSnap();
      if (win && !win.isDestroyed()) {
        const size = getCurrentPixelSize();
        const { x, y } = win.getBounds();
        const clamped = clampToScreen(x, y, size.width, size.height);
        win.setBounds({ ...clamped, width: size.width, height: size.height });
        syncHitWin();
        repositionUpdateBubble();
        // 중력 낙하: 놓으면 바닥으로 떨어짐
        startGravityFall();
      }
    }
  });

  // 흔들기 감지 → 어지러움 애니메이션
  ipcMain.on("shake-detected", () => {
    if (shakeDizzyUntil < Date.now()) {
      // showSpeech 쓰려면 ctx 필요하지만 간단히 직접 호출
      if (typeof showSpeech === "function") showSpeech("어지러워!", 1500);
    }
    shakeDizzyUntil = Date.now() + 2500;
    try { setState("error", "clawd-dizzy.svg"); } catch (e) {}
  });

  ipcMain.on("exit-mini-mode", () => {
    if (_mini.getMiniMode()) exitMiniMode();
  });

  ipcMain.on("focus-terminal", () => {
    // Find the best session to focus: prefer highest priority (non-idle), then most recent
    let best = null, bestTime = 0, bestPriority = -1;
    for (const [, s] of sessions) {
      if (!s.sourcePid) continue;
      const pri = STATE_PRIORITY[s.state] || 0;
      if (pri > bestPriority || (pri === bestPriority && s.updatedAt > bestTime)) {
        best = s;
        bestTime = s.updatedAt;
        bestPriority = pri;
      }
    }
    if (best) focusTerminalWindow(best.sourcePid, best.cwd, best.editor, best.pidChain);
  });

  ipcMain.on("show-session-menu", () => {
    popupMenuAt(Menu.buildFromTemplate(buildSessionSubmenu()));
  });

  ipcMain.on("bubble-height", (event, height) => _perm.handleBubbleHeight(event, height));
  ipcMain.on("permission-decide", (event, behavior) => _perm.handleDecide(event, behavior));
  ipcMain.on("update-bubble-height", (event, height) => handleUpdateBubbleHeight(event, height));
  ipcMain.on("update-bubble-action", (event, actionId) => handleUpdateBubbleAction(event, actionId));

  initFocusHelper();
  startMainTick();
  startHttpServer();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // If hooks arrived during startup, respect them instead of forcing idle
  // Also handles crash recovery (render-process-gone → reload)
  win.webContents.on("did-finish-load", () => {
    sendToRenderer("theme-config", themeLoader.getRendererConfig());
    if (themeReloadInProgress) return;
    syncRendererStateAfterLoad();
  });

  // ── Crash recovery: renderer process can die from <object> churn ──
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer crashed:", details.reason);
    dragLocked = false;
    idlePaused = false;
    mouseOverPet = false;
    win.webContents.reload();
  });

  guardAlwaysOnTop(win);
  startTopmostWatchdog();

  // ── Display change: re-clamp window to prevent off-screen ──
  // In proportional mode, also recalculate size based on the new work area.
  screen.on("display-metrics-changed", () => {
    reapplyMacVisibility();
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniMode()) {
      _mini.handleDisplayChange();
      return;
    }
    const size = getCurrentPixelSize();
    const { x, y } = win.getBounds();
    const clamped = clampToScreen(x, y, size.width, size.height);
    if (isProportionalMode() || clamped.x !== x || clamped.y !== y) {
      win.setBounds({ ...clamped, width: size.width, height: size.height });
      syncHitWin();
      repositionUpdateBubble();
    }
  });
  screen.on("display-removed", () => {
    reapplyMacVisibility();
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniMode()) {
      exitMiniMode();
      return;
    }
    const size = getCurrentPixelSize();
    const { x, y } = win.getBounds();
    const clamped = clampToScreen(x, y, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
    syncHitWin();
    repositionUpdateBubble();
  });
  screen.on("display-added", () => {
    reapplyMacVisibility();
    repositionUpdateBubble();
  });
}

// Read primary display safely — getPrimaryDisplay() can also throw during
// display topology changes, so wrap it. Returns null on failure; the pure
// helpers in work-area.js will fall through to a synthetic last-resort.
function getPrimaryWorkAreaSafe() {
  try {
    const primary = screen.getPrimaryDisplay();
    return (primary && primary.workArea) || null;
  } catch {
    return null;
  }
}

function getNearestWorkArea(cx, cy) {
  return findNearestWorkArea(screen.getAllDisplays(), getPrimaryWorkAreaSafe(), cx, cy);
}

// Loose clamp used during drag: union of all display work areas as the boundary,
// so the pet can freely cross between screens. Only prevents going fully off-screen.
function looseClampToDisplays(x, y, w, h) {
  return computeLooseClamp(screen.getAllDisplays(), getPrimaryWorkAreaSafe(), x, y, w, h);
}

function clampToScreen(x, y, w, h) {
  const nearest = getNearestWorkArea(x + w / 2, y + h / 2);
  const mLeft  = Math.round(w * 0.25);
  const mRight = Math.round(w * 0.25);
  const mTop   = Math.round(h * 0.6);
  const mBot   = Math.round(h * 0.04);
  return {
    x: Math.max(nearest.x - mLeft, Math.min(x, nearest.x + nearest.width - w + mRight)),
    y: Math.max(nearest.y - mTop,  Math.min(y, nearest.y + nearest.height - h + mBot)),
  };
}

// ── Mini Mode — initialized here after state module ──
const _miniCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
  get currentSize() { return currentSize; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  SIZES,
  getCurrentPixelSize,
  isProportionalMode,
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  applyState,
  resolveDisplayState,
  getSvgOverride,
  stopWakePoll,
  clampToScreen,
  getNearestWorkArea,
  get bubbleFollowPet() { return bubbleFollowPet; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionFloatingBubbles(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
};
const _mini = require("./mini")(_miniCtx);
const { enterMiniMode, exitMiniMode, enterMiniViaMenu, miniPeekIn, miniPeekOut,
        checkMiniModeSnap, cancelMiniTransition, animateWindowX, animateWindowParabola } = _mini;

// Convenience getters for mini state (used throughout main.js)
Object.defineProperties(this || {}, {}); // no-op placeholder
// Mini state is accessed via _mini getters in ctx objects below

// ── Theme switching ──
function switchTheme(themeId) {
  if (!win || win.isDestroyed()) return;
  if (activeTheme && activeTheme._id === themeId) return;

  // 1. Cleanup timers in all modules
  _state.cleanup();
  _tick.cleanup();
  _mini.cleanup();
  // ⚠️ Don't clear pendingPermissions — permission bubbles are independent BrowserWindows
  // ��️ Don't clear sessions — keep active session tracking
  // ��️ Don't clear displayHint — semantic tokens resolve through new theme's map

  // 2. If currently in mini mode and new theme doesn't support mini, exit first
  const newTheme = themeLoader.loadTheme(themeId);
  if (_mini.getMiniMode() && !newTheme.miniMode.supported) {
    _mini.exitMiniMode();
  }

  // 3. Update active theme
  activeTheme = newTheme;
  _mini.refreshTheme();
  _state.refreshTheme();
  _tick.refreshTheme();
  if (_mini.getMiniMode()) _mini.handleDisplayChange();

  // 4. Reload both windows
  themeReloadInProgress = true;
  win.webContents.reload();
  hitWin.webContents.reload();

  // 5. After both reloads complete, re-sync state with the new theme.
  let ready = 0;
  const onReady = () => {
    if (++ready < 2) return;
    themeReloadInProgress = false;
    syncHitStateAfterLoad();
    syncRendererStateAfterLoad({ includeStartupRecovery: false });
    syncHitWin();
    startMainTick();
  };
  win.webContents.once("did-finish-load", onReady);
  hitWin.webContents.once("did-finish-load", onReady);

  // Persist theme choice through the controller so it survives restarts.
  // flushRuntimeStateToPrefs only captures window bounds + mini state;
  // user-selected prefs like `theme` must be written explicitly.
  _settingsController.applyBulk({ theme: themeId });
  flushRuntimeStateToPrefs();
  rebuildAllMenus();
}

// ── Auto-install VS Code / Cursor terminal-focus extension ──
const EXT_ID = "clawd.clawd-terminal-focus";
const EXT_VERSION = "0.1.0";
const EXT_DIR_NAME = `${EXT_ID}-${EXT_VERSION}`;

function installTerminalFocusExtension() {
  const os = require("os");
  const home = os.homedir();

  // Extension source — in dev: ../extensions/vscode/, in packaged: app.asar.unpacked/
  let extSrc = path.join(__dirname, "..", "extensions", "vscode");
  extSrc = extSrc.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);

  if (!fs.existsSync(extSrc)) {
    console.log("Clawd: terminal-focus extension source not found, skipping auto-install");
    return;
  }

  const targets = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];

  const filesToCopy = ["package.json", "extension.js"];
  let installed = 0;

  for (const extRoot of targets) {
    if (!fs.existsSync(extRoot)) continue; // editor not installed
    const dest = path.join(extRoot, EXT_DIR_NAME);
    // Skip if already installed (check package.json exists)
    if (fs.existsSync(path.join(dest, "package.json"))) continue;
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const file of filesToCopy) {
        fs.copyFileSync(path.join(extSrc, file), path.join(dest, file));
      }
      installed++;
      console.log(`Clawd: installed terminal-focus extension to ${dest}`);
    } catch (err) {
      console.warn(`Clawd: failed to install extension to ${dest}:`, err.message);
    }
  }
  if (installed > 0) {
    console.log(`Clawd: terminal-focus extension installed to ${installed} editor(s). Restart VS Code/Cursor to activate.`);
  }
}

// ── Single instance lock ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — quit silently
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.showInactive();
      if (isLinux) win.setSkipTaskbar(true);
    }
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      if (isLinux) hitWin.setSkipTaskbar(true);
    }
    reapplyMacVisibility();
  });

  // macOS: hide dock icon early if user previously disabled it
  if (isMac && app.dock) {
    if (_settingsController.get("showDock") === false) {
      app.dock.hide();
    }
  }

  app.whenReady().then(() => {
    // Import system-backed settings (openAtLogin) into prefs on first run.
    // Must run before createWindow() so the first menu draw sees the
    // hydrated value rather than the schema default.
    hydrateSystemBackedSettings();

    permDebugLog = path.join(app.getPath("userData"), "permission-debug.log");
    updateDebugLog = path.join(app.getPath("userData"), "update-debug.log");
    createWindow();

    // Register global shortcut for toggling pet visibility
    registerToggleShortcut();

    // Start Codex CLI JSONL log monitor
    try {
      const CodexLogMonitor = require("../agents/codex-log-monitor");
      const codexAgent = require("../agents/codex");
      _codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra) => {
        if (state === "codex-permission") {
          updateSession(sid, "notification", event, null, extra.cwd, null, null, null, "codex");
          showCodexNotifyBubble({
            sessionId: sid,
            command: extra.permissionDetail?.command || "",
          });
          return;
        }
        // Non-permission event — clear any lingering Codex notify bubbles
        clearCodexNotifyBubbles(sid);
        updateSession(sid, state, event, null, extra.cwd, null, null, null, "codex");
      });
      _codexMonitor.start();
    } catch (err) {
      console.warn("Clawd: Codex log monitor not started:", err.message);
    }

    // Start Gemini CLI session JSON monitor
    try {
      const GeminiLogMonitor = require("../agents/gemini-log-monitor");
      const geminiAgent = require("../agents/gemini-cli");
      _geminiMonitor = new GeminiLogMonitor(geminiAgent, (sid, state, event, extra) => {
        updateSession(sid, state, event, null, extra.cwd, null, null, null, "gemini-cli");
      });
      _geminiMonitor.start();
    } catch (err) {
      console.warn("Clawd: Gemini log monitor not started:", err.message);
    }

    // Auto-install VS Code/Cursor terminal-focus extension
    try { installTerminalFocusExtension(); } catch (err) {
      console.warn("Clawd: failed to auto-install terminal-focus extension:", err.message);
    }

    // Auto-updater: setup event handlers (user triggers check via tray menu)
    setupAutoUpdater();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    flushRuntimeStateToPrefs();
    unregisterToggleShortcut();
    globalShortcut.unregisterAll();
    _perm.cleanup();
    _server.cleanup();
    _updateBubble.cleanup();
    _state.cleanup();
    _tick.cleanup();
    _mini.cleanup();
    if (_codexMonitor) _codexMonitor.stop();
    if (_geminiMonitor) _geminiMonitor.stop();
    stopTopmostWatchdog();
    if (hwndRecoveryTimer) { clearTimeout(hwndRecoveryTimer); hwndRecoveryTimer = null; }
    _focus.cleanup();
    if (hitWin && !hitWin.isDestroyed()) hitWin.destroy();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
