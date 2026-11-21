// Android app: stereo AR view + settings screen. Forked from web/src/main.ts (see PLAN.md, phase 4).
// Differences from the web app:
//   - the view starts right away on launch; settings open from the ⚙ button (top right) or a
//     long-press, and "Done" or Android back returns to the view
//   - live data only (no demo snapshot): planes come from the in-app engine (src/flights) around
//     the phone's GPS position, not from flight-service
//   - two-speed traffic (src/traffic): the view shows planes within the AR radius; the ☰ list
//     (src/list) covers everything within 250 nm, with filters, sorting and paging
//   - no voice assistant, no casting
//   - fullscreen, landscape and keep-screen-on are native (MainActivity), so the web workarounds
//     (requestFullscreen, wake lock, "tap to resume", popstate trick) are gone
//   - Android back = leave the view; backgrounding the app suspends camera/sensors/polling
//   - no phone presets: screen size and camera FOV are measured natively (any phone works), and the
//     in-headset calibration handles the rest
// Everything else (HUD, stereo layout, heading, calibration) is imported from web/src unchanged.

import { DEFAULT_IPD_MM, DEFAULT_SETTINGS, getPreset, loadSettings, pxPerMm, saveSettings } from '@web/config';
import type { Settings } from '@web/config';
import { describeStream, getZoom, getZoomRange, listCameras, setZoom, startCamera } from '@web/camera';
import { halfFovDeg, normalizeDeg, visibleHalfTan } from '@web/geo';
import { drawHud } from '@web/hud';
import { MAG_DECLINATION_DEG, startOrientation } from '@web/orientation';
import type { OrientationTracker } from '@web/orientation';
import type { HudState } from '@web/hud';
import { createStereoView } from '@web/stereo';
import type { StereoView } from '@web/stereo';
import { lensFov } from './camera-fov';
import type { LensFov } from './camera-fov';
import { declinationCorrectionDeg, fieldModel, updateFieldModel } from './compass';
import { createCompassCalibration } from './compass-calibration';
import { loadAppSettings, saveAppSettings } from './app-settings';
import type { AppSettings } from './app-settings';
import { cachedRoute, lookupRoutes } from './flights/adsb';
import { fixedPosition, watchPosition } from './flights/gps';
import type { GpsWatch } from './flights/gps';
import { DEFAULT_RADIUS_KM, KM_PER_NM, MAX_AR_RADIUS_KM, WIDE_RADIUS_NM } from './flights/nearby';
import { drawList, hitList } from './list/draw';
import { createList } from './list/list';
import { startTraffic } from './traffic/traffic';
import type { Traffic } from './traffic/traffic';
import type { WideMode } from './traffic/wide';
import { exitApp, handleBackButton, handlePauseResume, requestLocationPermission } from './native';
import { measureScreenLongEdgeMm } from './screen-size';

// Desktop only (npm run dev): ?dev=1 = arrow keys set the heading, camera optional.
// Add &at=<lat>,<lon> to stand somewhere without GPS, e.g. ?dev=1&at=41.391,-83.6301 (Wood County).
const QUERY = new URLSearchParams(location.search);
const DEV = QUERY.has('dev');
const DEV_AT = DEV ? parseLatLon(QUERY.get('at')) : null;

function parseLatLon(value: string | null): { lat: number; lon: number } | null {
  const [lat, lon] = (value ?? '').split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** Sky markers: your eyes are this far above the ground (5'9"). Only used with FALLBACK_GROUND_M. */
const EYE_HEIGHT_M = 1.75;
/**
 * Ground elevation used until GPS reports an altitude (meters, ~Bowling Green, OH). Change it for
 * wherever you demo: plane altitudes are above sea level, so this matters far more than eye height.
 */
const FALLBACK_GROUND_M = 205;

/** A typical ~6.3" phone: used only when the screen size or lens FOV can't be measured. */
const FALLBACK = getPreset('generic');

const settingsScreen = document.getElementById('settings-screen')!;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const ipdInput = document.getElementById('ipd-input') as HTMLInputElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
const wideSelect = document.getElementById('wide-select') as HTMLSelectElement;
const listBtn = document.getElementById('list-btn') as HTMLButtonElement;
const doneBtn = document.getElementById('done-btn') as HTMLButtonElement;
const calibrateBtn = document.getElementById('calibrate-btn') as HTMLButtonElement;
/** Compass calibration screen, opened from settings; closing it returns to settings. */
const calibration = createCompassCalibration(() => (settingsScreen.hidden = false));
const settingsStatus = document.getElementById('settings-status')!;
const stereoEl = document.getElementById('stereo')!;

let settings: Settings = { ...DEFAULT_SETTINGS };
let appSettings: AppSettings = loadAppSettings();
let view: StereoView | null = null;
let stream: MediaStream | null = null;
/** Measured FOV of the lens the camera stream came from; null = use the fallback estimate. */
let lens: LensFov | null = null;
/** Measured long edge of the screen in mm; null = unknown, use the fallback. */
let screenMm: number | null = null;
let orientation: OrientationTracker | null = null;
/** Near (AR) + wide (250 nm) plane data. Null while the view is closed or the app is in the background. */
let traffic: Traffic | null = null;
let gps: GpsWatch | null = null;
/** App is in the background with the view open: camera, sensors and polling are stopped. */
let suspended = false;
let rafId = 0;
let devHeading = 0;
let devPitch = 0;
/** The plane the view is centered on, as of the last frame drawn. */
let lastFocusId: string | null = null;
/** Radar range override in km (null = fit the planes shown). Voice sets this in Phase 3; dev mode: R. */
let radarRangeKm: number | null = null;
const DEV_RADAR_RANGES_KM = [null, 50, 100 * KM_PER_NM, WIDE_RADIUS_NM * KM_PER_NM];
/** Latest computed half-FOV, for the calibration toast and debug line. */
let lastHalfFovDeg = 0;
let hudError = '';
let toast = '';
let toastTimer = 0;

// In-headset calibration. Locked by default so stray touches (cheek, headset edge) do nothing.
// Double-tap the middle to unlock; then middle tap = next setting, left/right = adjust.
// Re-locks after LOCK_AFTER_MS without a tap (except in 'info', which stays up).
type Mode = 'zoom' | 'tilt' | 'spacing' | 'shift' | 'size' | 'fov' | 'info';
const MODES: Mode[] = ['zoom', 'tilt', 'spacing', 'shift', 'size', 'fov', 'info'];
let mode: Mode | null = null;
let lockTimer = 0;
let lastMiddleTap = 0;
const LOCK_AFTER_MS = 6000;
const DOUBLE_TAP_MS = 400;
const LONG_PRESS_MS = 1500;
let longPressTimer = 0;
let longPressFired = false;

async function initSettings() {
  const saved = loadSettings();
  settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    // Not in the Android app: presets are replaced by measuring, data is always live,
    // and there's no voice or casting.
    presetId: FALLBACK.id,
    dataMode: 'live',
    voiceEnabled: false,
    castEnabled: false,
  };
  screenMm = await measureScreenLongEdgeMm();
  ipdInput.value = String(settings.ipdMm);
  // A radius saved by an older build (up to 400 km) is brought down to the AR maximum.
  if (settings.radiusKm != null) settings.radiusKm = Math.min(MAX_AR_RADIUS_KM, settings.radiusKm);
  radiusInput.value = settings.radiusKm == null ? '' : String(settings.radiusKm);
  wideSelect.value = appSettings.wideTraffic;
  await refreshCameraList();

  if (DEV) {
    settingsStatus.textContent =
      'Dev mode: ← → turn, ↑ ↓ look up/down (Shift = 10°) · L list · PgUp/PgDn page · F filter presets · 1–8 open row · Esc back · R radar range.';
  }
}

/** Camera labels are only available after permission has been granted once. */
async function refreshCameraList() {
  const cams = await listCameras();
  cameraSelect.replaceChildren(new Option('Auto (rear)', ''));
  cams.forEach((c, i) => cameraSelect.add(new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  cameraSelect.value = cams.some((c) => c.deviceId === settings.cameraId) ? settings.cameraId : '';
}

/** AR radius. Blank or invalid = null (DEFAULT_RADIUS_KM in flights/nearby.ts); capped at MAX_AR_RADIUS_KM. */
function parseRadius(value: string): number | null {
  const r = Number(value);
  if (!value.trim() || !Number.isFinite(r) || r <= 0) return null;
  return Math.min(MAX_AR_RADIUS_KM, Math.max(1, Math.round(r)));
}

function readSettingsFromForm() {
  const ipd = Number(ipdInput.value);
  settings = {
    ...settings,
    ipdMm: Number.isFinite(ipd) && ipd > 0 ? ipd : DEFAULT_IPD_MM,
    cameraId: cameraSelect.value,
    radiusKm: parseRadius(radiusInput.value),
  };
  radiusInput.value = settings.radiusKm == null ? '' : String(settings.radiusKm);
  saveSettings(settings);
  appSettings = { ...appSettings, wideTraffic: wideSelect.value as WideMode };
  saveAppSettings(appSettings);
}

function relayout() {
  if (!view) return;
  view.layout({
    pxPerMm: pxPerMm({ ...FALLBACK, screenWidthMm: screenMm ?? FALLBACK.screenWidthMm }),
    ipdMm: settings.ipdMm,
    offsetMm: settings.offsetMm,
    viewScale: settings.viewScale,
    tiltDeg: settings.tiltDeg,
  });
  renderOverlay();
}

/**
 * True-north heading of the rear camera. web/src/orientation.ts corrects magnetic north with Atlanta's
 * fixed declination; this swaps in the local declination from Earth's field model (compass.ts).
 */
function currentHeading(): number | null {
  if (DEV) return devHeading;
  const h = orientation?.get()?.headingDeg;
  return h == null ? null : normalizeDeg(h + declinationCorrectionDeg());
}

/** Camera pitch in degrees above the horizon (null until the sensors report). */
function currentPitch(): number | null {
  if (DEV) return devPitch;
  return orientation?.get()?.pitchDeg ?? null;
}

/** Your eye altitude (m, WGS84 like ADS-B alt_geom): GPS when it has one, else the fallback ground + eye height. */
function viewerAltM(): number {
  return gps?.get()?.altM ?? FALLBACK_GROUND_M + EYE_HEIGHT_M;
}

/**
 * The plane list (☰). It outlives `traffic`, which is rebuilt whenever tracking restarts, so its
 * filter and page survive a trip to settings or the background.
 */
const list = createList({
  planes: () => traffic?.all() ?? [],
  coverage: () => traffic?.coverage() ?? { radius: `${WIDE_RADIUS_NM} nm`, ageS: null, note: 'paused' },
  viewerAltM,
  arRadiusKm: () => traffic?.arRadiusKm ?? DEFAULT_RADIUS_KM,
  lookupRoute: (p) => void lookupRoutes([p]),
  routeFor: cachedRoute,
});

/** Per-frame: compute the visible FOV and draw the HUD canvas in both eyes. */
function frame() {
  if (!view) return;
  rafId = requestAnimationFrame(frame);

  const { width, height } = view.eyeSize();
  if (!width || !height) return;
  const video = view.eyes[0].video;
  const streamAspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
  const zoom = (stream && getZoom(stream)) || 1;
  const halfTan = visibleHalfTan(
    lens?.halfTan1x ?? FALLBACK.cameraHalfTan1x,
    zoom,
    width / height,
    streamAspect,
    settings.fovScale,
  );
  lastHalfFovDeg = halfFovDeg(halfTan);

  const feedState = traffic?.near.get();
  const listView = list.view();
  const opened = listView?.opened ?? null;
  const hud: HudState = {
    headingDeg: currentHeading(),
    halfTan,
    // Only the AR feed's planes get compass icons and sky brackets, however much the list holds.
    planes: feedState?.planes ?? [],
    status: feedState?.status ?? '',
    timeMs: performance.now(),
    voice: null,
    pitchDeg: currentPitch(),
    viewerAltM: viewerAltM(),
    radarRangeKm,
  };
  // Looking straight at the plane you opened: the panel steps aside (it would sit on top of the
  // plane) and the regular card under its bracket takes over until you look away.
  const lookingAtOpened = !!opened && opened.inAr && lastFocusId === opened.plane.id;
  const showPanel = !!listView && !lookingAtOpened;
  if (listView) {
    // The list's panel takes the card's place, and the radar shows what the list holds.
    hud.showCard = !showPanel;
    const openedShown = !opened || opened.lost || listView.matched.some((p) => p.id === opened.plane.id);
    hud.radarPlanes = openedShown ? listView.matched : [...listView.matched, opened!.plane];
    if (opened && !opened.lost) {
      hud.highlightIds = [opened.plane.id];
      if (opened.inAr) hud.guideId = opened.plane.id;
    }
  }
  // The list's left edge runs through the middle of the view: no crosshair while it's open.
  stereoEl.classList.toggle('list-open', showPanel);
  listBtn.classList.toggle('on', !!listView);
  // Both eyes get identical input (required for the images to fuse).
  for (const eye of view.eyes) {
    lastFocusId = drawHud(eye.ctx, width, height, hud).focus?.id ?? null;
    if (listView && showPanel) drawList(eye.ctx, width, height, listView, hud.headingDeg, hud.timeMs);
  }
}

/** DOM overlay: crosshair, calibration toast, errors, debug line. Redrawn on events, not per frame. */
function renderOverlay() {
  if (!view) return;
  let debug = '';
  if (mode === 'info') {
    const o = orientation?.get();
    const heading = currentHeading();
    const hdg = DEV ? `dev ${Math.round(devHeading)}°` : o && heading != null ? `${Math.round(heading)}° ${o.source}` : 'no compass';
    const model = fieldModel();
    const decl = model
      ? `decl ${model.declinationDeg > 0 ? '+' : ''}${model.declinationDeg.toFixed(1)}°${model.source === 'saved' ? ' (saved)' : ''}`
      : `decl ${MAG_DECLINATION_DEG}° (Atlanta default)`;
    const lensInfo = lens ? `camera ${lens.cameraId} ${Math.round(halfFovDeg(lens.halfTan1x) * 2)}°` : 'assumed';
    const screenInfo = screenMm ? `screen ${Math.round(screenMm)}mm` : `screen ~${FALLBACK.screenWidthMm}mm assumed`;
    debug = `<div class="debug">${hdg} · ${decl} · fov ${Math.round(lastHalfFovDeg * 2)}° (lens ${lensInfo}) · ${traffic?.near.get().status ?? ''} · ${wideInfo()}<br>
      ${screenInfo} · tilt ${settings.tiltDeg}° · ${settings.ipdMm}mm · shift ${settings.offsetMm}mm · ${Math.round(settings.viewScale * 100)}% · ${stream ? describeStream(stream) : 'no camera'}</div>`;
  }
  const error = hudError ? `<div class="hud-error">${hudError}</div>` : '';
  const toastHtml = toast ? `<div class="toast">${toast}</div>` : '';
  const html = `<div class="crosshair"></div>${error}${toastHtml}${debug}`;
  for (const eye of view.eyes) eye.overlay.innerHTML = html;
}

/** The 250 nm data for the info line: how many planes, how big the download was, how old it is. */
function wideInfo(): string {
  if (!traffic) return '';
  const { wide } = traffic;
  const fetchedAt = wide.fetchedAt();
  const note = wide.note();
  if (fetchedAt == null) return `wide: ${note}`;
  const kb = Math.round((wide.bytes() ?? 0) / 1024);
  const age = Math.round((Date.now() - fetchedAt) / 1000);
  return `wide: ${wide.planes(gps?.get() ?? null).length} planes, ${kb} kB, ${age} s old${note ? `, ${note}` : ''}`;
}

/** Heading + plane data. Stopped while the app is in the background. */
function startTracking() {
  if (!DEV) orientation = startOrientation();
  const watch = DEV_AT ? fixedPosition(DEV_AT) : watchPosition((pos) => updateFieldModel(pos.lat, pos.lon));
  gps = watch;
  traffic = startTraffic({ arRadiusKm: settings.radiusKm, wideMode: appSettings.wideTraffic, getPosition: watch.get });
}

function stopTracking() {
  orientation?.stop();
  traffic?.stop();
  gps?.stop();
  orientation = null;
  traffic = null;
  gps = null;
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  lens = null;
}

/** Looks up the exact FOV of the lens behind `s` (async; the fallback estimate is used until then). */
function identifyLens(s: MediaStream) {
  lensFov(s.getVideoTracks()[0]).then((l) => {
    if (stream !== s) return;
    lens = l;
    renderOverlay();
  });
}

function startErrorText(err: unknown): string {
  const e = err as Error;
  if (e?.name === 'NotAllowedError') {
    return 'Camera permission denied. Allow it in Android Settings → Apps → Bombirdier → Permissions.';
  }
  return `Could not start: ${e?.message ?? err}`;
}

/** Opens the AR view: on launch, and from settings ("Done" / back). On failure, settings show why. */
async function start() {
  if (view || doneBtn.disabled) return;
  readSettingsFromForm();
  doneBtn.disabled = true;
  settingsStatus.textContent = 'Starting…';

  try {
    const locationOk = await requestLocationPermission();
    try {
      stream = await startCamera(settings.cameraId || undefined);
    } catch (err) {
      if (!DEV) throw err;
      stream = null; // Dev mode works without a camera.
    }

    startTracking();
    view = createStereoView(stereoEl, stream);
    mode = null;
    longPressFired = false;
    suspended = false;
    settingsScreen.hidden = true;
    stereoEl.hidden = false;
    settingsBtn.hidden = false;
    listBtn.hidden = false;
    settingsStatus.textContent = '';
    hudError = locationOk
      ? ''
      : 'Location permission denied: the app needs GPS to find planes near you. Allow it in Android Settings → Apps → Bombirdier → Permissions.';
    relayout();
    rafId = requestAnimationFrame(frame);
    if (stream) {
      identifyLens(stream);
      watchForFrames(stream);
      applySavedZoom(stream);
    }
  } catch (err) {
    stopCamera();
    settingsStatus.textContent = startErrorText(err);
    settingsScreen.hidden = false;
  } finally {
    doneBtn.disabled = false;
  }
}

/** Applied after the view is showing so a slow zoom change can't stall startup. */
async function applySavedZoom(s: MediaStream) {
  const range = getZoomRange(s);
  if (!range) return;
  const target = settings.cameraZoom ?? range.min;
  await setZoom(s, Math.min(range.max, Math.max(range.min, target)));
  renderOverlay();
}

/** Surface a stuck camera instead of showing a silent black screen. */
function watchForFrames(s: MediaStream) {
  setTimeout(() => {
    if (!view || stream !== s) return;
    const video = view.eyes[0].video;
    if (video.videoWidth === 0) {
      const track = s.getVideoTracks()[0];
      hudError = `No camera frames (track ${track?.readyState ?? 'missing'}, video paused=${video.paused}). Open ⚙ settings and tap Done to retry.`;
      renderOverlay();
    }
  }, 3000);
}

/** App went to the background: release the camera, sensors and network polling. The view stays. */
function suspend() {
  if (!view || suspended) return;
  suspended = true;
  cancelAnimationFrame(rafId);
  stopCamera();
  stopTracking();
}

/** Back from the background: restart what suspend() stopped and reattach the camera to both eyes. */
async function resume() {
  if (!view || !suspended) return;
  suspended = false;
  startTracking();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(frame);
  try {
    const s = await startCamera(settings.cameraId || undefined);
    if (!view || suspended) {
      // Left the view (or went to the background again) while the camera was starting.
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    for (const eye of view.eyes) {
      eye.video.srcObject = s;
      eye.video.play().catch(() => {});
    }
    identifyLens(s);
    watchForFrames(s);
    applySavedZoom(s);
  } catch (err) {
    if (!DEV) {
      hudError = startErrorText(err);
      renderOverlay();
    }
  }
}

/** Closes the view and shows settings (⚙ button or long-press). Camera, sensors and polling stop. */
function openSettings() {
  cancelAnimationFrame(rafId);
  clearTimeout(lockTimer);
  stopCamera();
  stopTracking();
  suspended = false;
  view = null;
  stereoEl.replaceChildren();
  stereoEl.hidden = true;
  settingsBtn.hidden = true;
  listBtn.hidden = true;
  settingsScreen.hidden = false;
  ipdInput.value = String(settings.ipdMm);
  refreshCameraList();
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

function modeLabel(): string {
  switch (mode) {
    case null:
      return 'locked';
    case 'zoom': {
      const z = stream && getZoom(stream);
      return `zoom ${z != null ? `${z.toFixed(1)}×` : '(n/a)'}`;
    }
    case 'tilt':
      return `tilt ${settings.tiltDeg > 0 ? '+' : ''}${settings.tiltDeg.toFixed(1)}°`;
    case 'size':
      return `size ${Math.round(settings.viewScale * 100)}%`;
    case 'spacing':
      return `spacing ${settings.ipdMm} mm`;
    case 'shift':
      return `shift ${settings.offsetMm > 0 ? '+' : ''}${settings.offsetMm} mm`;
    case 'fov':
      return `fov ${Math.round(lastHalfFovDeg * 2)}°`;
    case 'info':
      return 'info';
  }
}

async function adjust(direction: -1 | 1) {
  switch (mode) {
    case 'zoom': {
      if (!stream) return showToast('no camera');
      const range = getZoomRange(stream);
      if (!range) return showToast('zoom not supported');
      const current = getZoom(stream) ?? range.min;
      const next = clamp(round2(current + direction * Math.max(range.step, 0.1)), range.min, range.max);
      settings.cameraZoom = next;
      showToast(`zoom ${next.toFixed(1)}×`);
      await setZoom(stream, next);
      break;
    }
    case 'tilt':
      settings.tiltDeg = clamp(settings.tiltDeg + direction * 0.5, -15, 15);
      break;
    case 'size':
      settings.viewScale = clamp(round2(settings.viewScale + direction * 0.02), 0.6, 1);
      break;
    case 'spacing':
      settings.ipdMm = clamp(settings.ipdMm + direction, 50, 80);
      break;
    case 'shift':
      settings.offsetMm = clamp(settings.offsetMm + direction, -20, 20);
      break;
    case 'fov':
      settings.fovScale = clamp(round2(settings.fovScale + direction * 0.03), 0.5, 1.5);
      break;
    case 'info':
    case null:
      return;
  }
  saveSettings(settings);
  relayout();
  // The FOV is recomputed in the next frame; show the toast after it.
  if (mode === 'fov') requestAnimationFrame(() => requestAnimationFrame(() => showToast(modeLabel())));
  else if (mode !== 'zoom') showToast(modeLabel());
}

/** Cycles zoom → … → info → locked. */
function cycleMode() {
  const i = mode ? MODES.indexOf(mode) + 1 : 0;
  mode = i < MODES.length ? MODES[i] : null;
  showToast(mode === null ? 'calibration locked' : mode === 'info' ? 'info' : `◀ ▶ ${modeLabel()}`);
}

function armAutoLock() {
  clearTimeout(lockTimer);
  if (!mode || mode === 'info') return;
  lockTimer = window.setTimeout(() => {
    mode = null;
    showToast('calibration locked');
  }, LOCK_AFTER_MS);
}

/** ☰: list on/off. (frame() lights the button up while the list is open.) */
const toggleList = () => list.toggle();

/** Screen point -> coordinates inside whichever eye it's in (HUD canvas px), or null if between/outside them. */
function eyePoint(clientX: number, clientY: number): { x: number; y: number; w: number; h: number } | null {
  if (!view) return null;
  const { width, height } = view.eyeSize();
  for (const eye of view.eyes) {
    const r = eye.root.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return { x: ((clientX - r.left) / r.width) * width, y: ((clientY - r.top) / r.height) * height, w: width, h: height };
    }
  }
  return null;
}

/** A tap on the list panel (in either eye): open a row, page, or go back. True if the list took it. */
function onListTap(clientX: number, clientY: number): boolean {
  const listView = list.view();
  const pt = eyePoint(clientX, clientY);
  const hit = listView && pt && stereoEl.classList.contains('list-open') ? hitList(pt.x, pt.y, pt.w, pt.h, listView) : null;
  if (!hit) return false;
  if (hit.type === 'row') list.openRow(hit.n);
  else if (hit.type === 'page') list.page(hit.direction);
  else if (hit.type === 'back') list.closePlane();
  return true;
}

// A vertical swipe that starts on the list pages it: up = next page, like scrolling.
const SWIPE_MIN_PX = 36;
let swipeStart: { x: number; y: number } | null = null;
let swipeHandled = false;

function onViewTap(e: MouseEvent) {
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  if (swipeHandled) {
    swipeHandled = false;
    return;
  }
  if (onListTap(e.clientX, e.clientY)) return;
  const x = e.clientX / window.innerWidth;
  const middle = x >= 1 / 3 && x <= 2 / 3;
  if (mode === null) {
    if (!middle) return;
    const now = performance.now();
    if (now - lastMiddleTap < DOUBLE_TAP_MS) {
      lastMiddleTap = 0;
      cycleMode();
      armAutoLock();
    } else {
      lastMiddleTap = now;
    }
    return;
  }
  if (middle) cycleMode();
  else adjust(x < 1 / 3 ? -1 : 1);
  armAutoLock();
}

function showToast(text: string) {
  toast = text;
  renderOverlay();
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast = '';
    renderOverlay();
  }, 1500);
}

doneBtn.addEventListener('click', start);
calibrateBtn.addEventListener('click', () => {
  settingsScreen.hidden = true;
  calibration.open();
});
// ⚙ sits outside #stereo, so its taps never reach the calibration tap handler.
settingsBtn.addEventListener('click', openSettings);
listBtn.addEventListener('click', toggleList);
stereoEl.addEventListener('click', onViewTap);
// Long-press anywhere = settings (reachable without finding the ⚙ corner, e.g. through the headset).
stereoEl.addEventListener('pointerdown', (e) => {
  const listView = list.view();
  const pt = eyePoint(e.clientX, e.clientY);
  swipeStart = listView && pt && hitList(pt.x, pt.y, pt.w, pt.h, listView) ? { x: e.clientX, y: e.clientY } : null;
  clearTimeout(longPressTimer);
  longPressTimer = window.setTimeout(() => {
    longPressFired = true;
    openSettings();
  }, LONG_PRESS_MS);
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
  stereoEl.addEventListener(type, () => clearTimeout(longPressTimer));
}
stereoEl.addEventListener('pointerup', (e) => {
  if (!swipeStart) return;
  const [dx, dy] = [e.clientX - swipeStart.x, e.clientY - swipeStart.y];
  swipeStart = null;
  if (Math.abs(dy) < SWIPE_MIN_PX || Math.abs(dy) < Math.abs(dx) * 1.5) return;
  list.page(dy < 0 ? 'next' : 'prev');
  swipeHandled = true; // the click that follows this pointerup is part of the swipe
});
window.addEventListener('keydown', (e) => {
  if (!DEV || !view) return;
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowLeft') devHeading = normalizeDeg(devHeading - step);
  else if (e.key === 'ArrowRight') devHeading = normalizeDeg(devHeading + step);
  else if (e.key === 'ArrowUp') devPitch = Math.min(89, devPitch + step);
  else if (e.key === 'ArrowDown') devPitch = Math.max(-89, devPitch - step);
  // The list, until voice control exists (Phase 3).
  else if (e.key === 'l' || e.key === 'L') toggleList();
  else if (e.key === 'r' || e.key === 'R') {
    radarRangeKm = DEV_RADAR_RANGES_KM[(DEV_RADAR_RANGES_KM.indexOf(radarRangeKm) + 1) % DEV_RADAR_RANGES_KM.length];
  } else if (!list.isOpen()) return;
  else if (e.key === 'PageDown') list.page('next');
  else if (e.key === 'PageUp') list.page('prev');
  else if (e.key === 'f' || e.key === 'F') list.cyclePreset();
  else if (e.key >= '1' && e.key <= '8') list.openRow(Number(e.key));
  else if (e.key === 'Escape' || e.key === 'Backspace') list.closePlane();
  else return;
  e.preventDefault();
});
window.addEventListener('resize', relayout);
// Back: in compass calibration = back to settings; in settings = back to the view; in the view = leave the app.
handleBackButton(() => {
  if (calibration.isOpen()) calibration.close();
  else if (view) exitApp();
  else start();
});
handlePauseResume(suspend, resume);
// Keep the info line's heading fresh while it's showing.
setInterval(() => {
  if (view && mode === 'info') renderOverlay();
}, 500);

// Straight into the view on launch; settings only show if it can't start (e.g. camera denied).
initSettings().then(start);
