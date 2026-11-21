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
import type { HudResult, HudState } from '@web/hud';
import type { Plane } from '@web/planes';
import { createStereoView } from '@web/stereo';
import { applySkyFilter, skyFilterFrom, skyFilterLabel } from './sky-filter';
import { drawSkyFilterChip } from './sky-filter-draw';
import type { ListFilter } from './list/filter';
import type { StereoView } from '@web/stereo';
import { lensFov } from './camera-fov';
import type { LensFov } from './camera-fov';
import { declinationCorrectionDeg, fieldModel, updateFieldModel } from './compass';
import { createCompassCalibration } from './compass-calibration';
import { WOOD_COUNTY } from './airports/1g0';
import { mslFtToEllipsoidM, runwayEnd } from './airports/airport';
import { AUTO_RUNWAY, loadAppSettings, saveAppSettings } from './app-settings';
import type { AppSettings } from './app-settings';
import { cachedRoute, cachedRouteInfo, hasNoRoute, lookupRoutes } from './flights/adsb';
import { createDepartures } from './departures/departures';
import type { AirfieldKind } from './airports/lookup';
import { haversineKm } from './flights/geo';
import { fixedPosition, watchPosition } from './flights/gps';
import type { GpsWatch } from './flights/gps';
import { DEFAULT_RADIUS_KM, KM_PER_NM, MAX_AR_RADIUS_KM, WIDE_RADIUS_NM } from './flights/nearby';
import { drawList, hitList } from './list/draw';
import { engineKind } from './list/kind';
import { createList } from './list/list';
import { createPatternTracker, legCode, legLabel } from './pattern/classify';
import { createAirportView } from './pattern/overlay';
import { createRunwayDetector } from './pattern/runway';
import { WIND_GOOD_FOR_MS, runwayForWind, windWords } from './pattern/wind';
import type { Wind } from './pattern/wind';
import { FACILITIES, channelsOf, facilityOfFeed } from './atc/facilities';
import type { Facility } from './atc/facilities';
import { createStations } from './atc/stations';
import type { StationInfo } from './atc/stations';
import { radioLine, whoControls } from './atc/whoControls';
import { drawConnected, drawRadio } from './radio/draw';
import type { ConnectedView } from './radio/draw';
import { createListener } from './radio/listen';
import { createRadio } from './radio/radio';
import { createAssistant } from './voice/assistant';
import { requestMicrophone } from './voice/recorder';
import { createServer } from './voice/server';
import type { AskResponse, ServerHealth } from './voice/server';
import { createTiltTrigger } from './voice/tilt';
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

/** The home field: its runways and traffic pattern are drawn, and planes near it get pattern legs. */
const AIRPORT = WOOD_COUNTY;
/** Sky markers: your eyes are this far above the ground (5'9"). Only used with FALLBACK_GROUND_M. */
const EYE_HEIGHT_M = 1.75;
/**
 * Ground height used until GPS reports an altitude: the home field's elevation, as meters above the
 * WGS84 ellipsoid like GPS and ADS-B alt_geom (673 ft MSL = 205 m, minus the 34 m the geoid sits
 * below the ellipsoid here = 171 m). Sky markers and the pattern in the sky are placed from it.
 */
const FALLBACK_GROUND_M = mslFtToEllipsoidM(AIRPORT, AIRPORT.elevationFt);

/** A typical ~6.3" phone: used only when the screen size or lens FOV can't be measured. */
const FALLBACK = getPreset('generic');

const settingsScreen = document.getElementById('settings-screen')!;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const ipdInput = document.getElementById('ipd-input') as HTMLInputElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
const wideSelect = document.getElementById('wide-select') as HTMLSelectElement;
const runwaySelect = document.getElementById('runway-select') as HTMLSelectElement;
const serverInput = document.getElementById('server-input') as HTMLInputElement;
const tokenInput = document.getElementById('token-input') as HTMLInputElement;
const radioSelect = document.getElementById('radio-select') as HTMLSelectElement;
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
/** "Only show helicopters in the sky": what the compass bar, the sky and the radar are limited to. null = everything. */
let skyFilter: ListFilter | null = null;
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
  runwaySelect.replaceChildren(
    new Option('Auto (from traffic)', AUTO_RUNWAY),
    ...AIRPORT.runways.map((r) => new Option(`${r.ident} (${r.patternSide} pattern)`, r.ident)),
  );
  runwaySelect.value = appSettings.activeRunway;
  serverInput.value = appSettings.serverUrl;
  tokenInput.value = appSettings.serverToken;
  radioSelect.value = appSettings.radioCalls ? 'on' : 'off';
  await refreshCameraList();

  if (DEV) {
    settingsStatus.textContent =
      'Dev mode: ← → turn, ↑ ↓ look up/down (Shift = 10°) · V talk · L list · PgUp/PgDn page · F filter presets · 1–8 open row · Esc back · R radar range.';
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
  const serverUrl = serverInput.value.trim();
  appSettings = {
    ...appSettings,
    wideTraffic: wideSelect.value as WideMode,
    activeRunway: runwaySelect.value || appSettings.activeRunway,
    activeRunwayChosen: (runwaySelect.value || appSettings.activeRunway) !== AUTO_RUNWAY,
    serverUrl: /^https?:\/\//.test(serverUrl) ? serverUrl : 'http://localhost:8787',
    serverToken: tokenInput.value.trim(),
    radioCalls: radioSelect.value !== 'off',
  };
  serverInput.value = appSettings.serverUrl;
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

/** Which pattern leg each nearby plane is on, with hysteresis. Follows the runway in use. */
const pattern = createPatternTracker(AIRPORT);
const airportView = createAirportView(AIRPORT);
/** Works out the runway in use from landings, takeoffs and downwind legs (used when the setting is Auto). */
const runwayDetector = createRunwayDetector(AIRPORT);
/** Where each plane was last on the ground: the "From Wood County · 25 min ago" line of planes with no route. */
const departures = createDepartures({ geoidSeparationM: AIRPORT.geoidSeparationM });
/** A plane with no route on file and none coming (most small planes): the card says where it left from instead. */
const routeless = (p: Plane) => !p.origin && !p.destination && hasNoRoute(p.callsign);

/**
 * The runway everything is drawn and named for: the one set by hand, or in Auto the one the traffic
 * has shown, or until then the calm-wind runway.
 */
/** The latest wind near the field (from the Mac), for when no traffic shows which runway is in use. */
let wind: Wind | null = null;
let windAskedAt = 0;
const freshWind = () => (wind && Date.now() - wind.at <= WIND_GOOD_FOR_MS ? wind : null);

function runwayInUse(): string {
  if (appSettings.activeRunway !== AUTO_RUNWAY) return appSettings.activeRunway;
  // What planes are actually doing beats what the wind suggests; the wind beats an assumption.
  const w = freshWind();
  return runwayDetector.current()?.ident ?? (w && runwayForWind(AIRPORT, w)?.ident) ?? AIRPORT.defaultRunway;
}

/** How the runway in use was arrived at, for the info line and the assistant. */
function runwaySource(): string {
  if (appSettings.activeRunway !== AUTO_RUNWAY) return 'set by hand';
  const seen = runwayDetector.current();
  if (seen) return `from ${seen.by} ${seen.strong ? 'landing or taking off' : 'on downwind'}`;
  const w = freshWind();
  if (w && runwayForWind(AIRPORT, w)) return `from the wind, ${windWords(w)} at ${w.station}; no pattern traffic seen yet`;
  return w ? `calm-wind runway: wind ${windWords(w)} at ${w.station}, no pattern traffic seen yet` : 'assumed: calm-wind runway, no pattern traffic or wind report yet';
}

/** Asks the Mac for the wind near the field every ten minutes, and says so if it changes the runway in use. */
async function refreshWind() {
  if (!serverHealth || Date.now() - windAskedAt < 10 * 60_000) return;
  windAskedAt = Date.now();
  const before = runwayInUse();
  const w = await macServer.wind(AIRPORT.position.lat, AIRPORT.position.lon);
  if (!w) {
    windAskedAt = Date.now() - 8 * 60_000; // try again in a couple of minutes
    return;
  }
  wind = { ...w, at: Date.now() };
  console.info(`[pattern] wind ${windWords(wind)} at ${wind.station}: runway ${runwayInUse()} (${runwaySource()})`);
  if (view && appSettings.activeRunway === AUTO_RUNWAY && runwayInUse() !== before) showToast(`Runway ${runwayInUse()} (wind ${windWords(wind)})`);
}

/** "Right downwind · RWY 28" for a plane in the pattern, else null. */
function legNote(id: string): string | null {
  const leg = pattern.legOf(id)?.leg;
  return leg ? legLabel(leg, runwayEnd(AIRPORT, runwayInUse())) : null;
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
  noteFor: legNote,
});

// ---- Voice assistant (Phase 3): head-tilt -> record -> Mac server -> speak ----

/** What the last frame showed: the plane in the middle of the view and the others on the compass. */
let lastHud: HudResult = { focus: null, inView: [] };
/** Is the Mac server there? Checked every few seconds while the view is open; null = not reachable. */
let serverHealth: ServerHealth | null = null;
let lastExchange: AskResponse | null = null;

/** The fields of a plane the assistant gets (the rest is noise to a language model). */
function brief(p: Plane) {
  return {
    id: p.id,
    callsign: p.callsign,
    registration: p.registration,
    typeCode: p.typeCode,
    typeName: p.typeName,
    airline: p.airline,
    origin: p.origin,
    destination: p.destination,
    kind: p.kind,
    engine: engineKind(p),
    altitudeFt: p.altitudeFt,
    verticalRateFpm: p.verticalRateFpm,
    groundSpeedKt: p.groundSpeedKt,
    distanceKm: Math.round(p.distanceKm * 10) / 10,
    bearingDeg: Math.round(p.bearingDeg),
    // Position and route airports: the Mac works out distance flown, distance to go and an arrival
    // estimate from them, and looks up the weather at each end.
    lat: Math.round(p.lat * 1e4) / 1e4,
    lon: Math.round(p.lon * 1e4) / 1e4,
    trackDeg: p.trackDeg,
    route: (p.callsign && cachedRouteInfo(p.callsign)) || null,
    onGround: p.onGround,
    emergency: p.emergency,
    military: p.military,
    medical: p.medical,
    tag: p.tag,
    leg: legNote(p.id),
    // Where the app saw it leave from (what its card says), so the answer matches.
    seenLeaving: departures.brief(p.id, Date.now()),
    // Who it's probably talking to, and whether it has been heard there.
    radio: appSettings.radioCalls ? (planeRadio(p)?.brief ?? null) : null,
  };
}

/** Everything the assistant should know about this moment. Built when a question is asked, not per frame. */
function voiceContext() {
  const all = traffic?.all() ?? [];
  const runway = runwayEnd(AIRPORT, runwayInUse());
  const viewer = gps?.get() ?? null;
  const listView = list.view();
  return {
    focus: lastHud.focus ? brief(lastHud.focus) : null,
    // A plane opened from the list is what "it" means when nothing is in the middle of the view.
    opened: listView?.opened && !listView.opened.lost ? brief(listView.opened.plane) : null,
    inView: [...lastHud.inView].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5).map(brief),
    // The home fleet, wherever it is: "are any BGSU planes up?" shouldn't depend on where you're looking.
    bgsu: all.filter((p) => p.tag === 'BGSU').sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5).map(brief),
    airport: {
      ident: AIRPORT.ident,
      name: AIRPORT.name,
      activeRunway: runway.ident,
      runwaySource: runwaySource(),
      patternSide: runway.patternSide,
      tpaFtMsl: AIRPORT.tpaFtMsl,
      elevationFt: AIRPORT.elevationFt,
      distanceKm: viewer ? airportView(viewer, runway.ident)?.distanceKm ?? null : null,
    },
    traffic: { total: all.length, radiusNm: WIDE_RADIUS_NM },
    // How far out planes get icons on the bar and brackets in the sky ("set the range to 75").
    arRadiusKm: traffic?.arRadiusKm ?? DEFAULT_RADIUS_KM,
    // What the sky is limited to, if anything ("only show helicopters in the sky").
    skyFilter: skyFilter ? skyFilterLabel(skyFilter) : null,
    // Roughly where you are (to about a kilometer), for the weather and the forecast nearest you.
    viewer: viewer ? { lat: Math.round(viewer.lat * 100) / 100, lon: Math.round(viewer.lon * 100) / 100 } : null,
    list: listView
      ? {
          open: true,
          filter: list.state().filter,
          matched: listView.matched.length,
          page: listView.page + 1,
          pages: listView.pages,
          rows: listView.rows.map((r) => ({ n: r.n, name: r.plane.callsign ?? r.plane.registration ?? r.plane.id, type: r.plane.typeCode })),
          opened: listView.opened ? (listView.opened.plane.callsign ?? listView.opened.plane.registration) : null,
        }
      : { open: false },
    // The controller in the middle of the view ("Can I access?" means this one), and the radio's state.
    station: lastHud.station ? stationBrief(lastHud.station.id) : null,
    radio: {
      connected: listener.connected(),
      audio: listener.state()?.audio ?? false,
      transcript: listener.state()?.transcript ?? false,
      // Which controller is tuned, and whether its whole transcript or one channel's is showing.
      scope: tuned ? (tuned.all ? 'facility' : 'channel') : null,
      // Every controller with its channels (one feed each on the Mac).
      stations: FACILITIES.map((f) => ({ id: f.id, name: f.name, feedId: firstChannel(f)?.id ?? null, channels: channels(f).map((c) => ({ feedId: c.id, name: c.channel })) })),
    },
  };
}

function stationBrief(id: string) {
  const f = FACILITIES.find((x) => x.id === id);
  return f ? { id: f.id, name: f.name, freqs: f.freqs, feedId: firstChannel(f)?.id ?? null } : null;
}

const macServer = createServer(
  () => appSettings.serverUrl,
  () => appSettings.serverToken,
);
const assistant = createAssistant({
  server: macServer,
  context: voiceContext,
  actions: {
    list,
    setRadarRangeKm: (km) => (radarRangeKm = km),
    setRunway: (ident) => {
      if (ident !== AUTO_RUNWAY && !AIRPORT.runways.some((r) => r.ident === ident)) return false;
      appSettings = { ...appSettings, activeRunway: ident, activeRunwayChosen: ident !== AUTO_RUNWAY };
      saveAppSettings(appSettings);
      runwaySelect.value = ident;
      return true;
    },
    setSkyFilter: (filter) => {
      skyFilter = filter === 'list' ? skyFilterFrom(list.state().filter) : skyFilterFrom(filter);
      const near = traffic?.near.get().planes ?? [];
      console.info(`[sky] filter ${skyFilter ? JSON.stringify(skyFilter) : 'off'}`);
      return { label: skyFilter ? skyFilterLabel(skyFilter) : null, matching: applySkyFilter(near, skyFilter).length, withinKm: traffic?.arRadiusKm ?? DEFAULT_RADIUS_KM };
    },
    setArRadiusKm: (km) => {
      // Same setting as "AR radius" on the settings screen: it sticks.
      settings = { ...settings, radiusKm: km == null ? null : Math.min(MAX_AR_RADIUS_KM, Math.max(1, Math.round(km))) };
      saveSettings(settings);
      radiusInput.value = settings.radiusKm == null ? '' : String(settings.radiusKm);
      traffic?.setArRadius(settings.radiusKm);
      console.info(`[traffic] AR radius ${settings.radiusKm ?? DEFAULT_RADIUS_KM} km`);
    },
    coverageNm: () => WIDE_RADIUS_NM,
    knownPlanes: () => traffic?.all().length ?? 0,
    radio: {
      connect: (feedId, scope) => connectFeed(feedId, scope),
      disconnect: () => disconnectRadio(),
      scope: (state) => {
        const facility = tuned && FACILITIES.find((f) => f.id === tuned!.facilityId);
        if (!tuned || !facility) return false;
        tuned = { ...tuned, all: state === 'all' && channels(facility).length > 1 };
        return true;
      },
      audio: (state) => listener.audio(state),
      transcript: (state) => listener.transcript(state),
    },
  },
  macVoice: () => serverHealth?.tts === 'ready',
  onExchange: (r) => {
    lastExchange = r;
    if (mode === 'info') renderOverlay();
  },
});
/**
 * Radio calls (Phase 4): the Mac transcribes a live ATC feed, and a call that names a plane lights
 * that plane up for a few seconds with the call as a subtitle.
 */
const radio = createRadio({
  server: macServer,
  planes: () => traffic?.all() ?? [],
  serverUp: () => !!serverHealth,
  callsignsByFeed: () => {
    // For each feed, the planes its controller is probably working, nearest to that controller first.
    // Planes in the very sector the feed carries (the guess names its frequency) come before the rest.
    const byFacility = new Map<Facility, { name: string; rank: number }[]>();
    for (const p of traffic?.all() ?? []) {
      const guess = whoControls(p);
      const f = guess?.facility;
      const name = p.callsign?.trim() || p.registration;
      if (!f || !name) continue;
      const km = haversineKm(p.lat, p.lon, f.position.lat, f.position.lon);
      byFacility.set(f, [...(byFacility.get(f) ?? []), { name, rank: km + (guess?.freq ? 0 : 10_000) }]);
    }
    // Every channel of a controller is told the same planes: which of them is on which frequency isn't known.
    const byFeed: Record<string, string[]> = {};
    for (const [f, list] of byFacility) {
      const names = list.sort((a, b) => a.rank - b.rank).slice(0, 25).map((x) => x.name);
      for (const c of channels(f)) byFeed[c.id] = names;
    }
    return byFeed;
  },
});

/** Listening in (Phase 5): one feed's live audio on the phone and its transcript on the HUD. */
const listener = createListener({ server: macServer });
const stations = createStations();

/**
 * The controller being listened to, and whether its transcript shows every channel it has or only
 * the one that is playing. (The audio is always one channel: `listener`.)
 */
let tuned: { facilityId: string; all: boolean } | null = null;

/** A controller's channels as the Mac has them right now. */
const channels = (f: Facility) => channelsOf(f, radio.feeds());
/** The channel to start on: the first that is live, else the first there is. */
const firstChannel = (f: Facility) => channels(f).find((c) => c.status === 'online') ?? channels(f)[0] ?? null;

/**
 * Starts listening to a feed. `scope`: "facility" = every channel of its controller in the
 * transcript, "channel" = only this one, undefined = as it was (when staying with the same
 * controller), else everything. Returns what to say if it can't, else null.
 */
function connectFeed(feedId: string, scope?: string): string | null {
  const feed = radio.feed(feedId);
  if (!feed) return "I can't find that frequency on the Mac.";
  const facility = facilityOfFeed(feed);
  const name = facility ? (channels(facility).length > 1 ? `${facility.name} ${feed.channel}` : facility.name) : feed.name;
  if (feed.status !== 'online') return `${name} isn't playing on the Mac right now.`;
  listener.connect(feedId);
  const all = scope === 'facility' ? true : scope === 'channel' ? false : tuned && tuned.facilityId === facility?.id ? tuned.all : true;
  tuned = facility ? { facilityId: facility.id, all } : null;
  console.info(`[radio] connected to ${name}${tuned?.all ? ' (all channels in the transcript)' : ''}`);
  return null;
}

function disconnectRadio() {
  listener.disconnect();
  tuned = null;
}

/** Who a plane is talking to: where it was actually heard, else a guess from where it is. */
function planeRadio(p: Plane) {
  const guess = whoControls(p);
  const heardAt = radio.heardOn(p.id);
  const heardFeed = heardAt ? radio.feed(heardAt.feedId) : null;
  const heardFacility = facilityOfFeed(heardFeed);
  // Which of the controller's frequencies, when it has several.
  const heardChannel = heardFeed && heardFacility && channels(heardFacility).length > 1 ? heardFeed.channel : null;
  const heard = heardAt && heardFacility ? { facility: heardFacility, agoS: heardAt.agoS, channel: heardChannel } : null;
  const facility = heard?.facility ?? guess?.facility;
  if (!facility) return null;
  const freq = guess?.facility.id === facility.id ? guess.freq : facility.freqs.length === 1 ? facility.freqs[0] : null;
  const start = heardFeed ?? firstChannel(facility);
  return {
    line: radioLine(guess, heard, !!start),
    brief: { facility: facility.id, name: facility.name, freq, feedId: start?.id ?? null, channel: heardChannel, heardAgoS: heard?.agoS ?? null },
  };
}

function stationInfo(f: Facility): StationInfo {
  const now = Date.now();
  return {
    channels: channels(f).map((c) => {
      const last = radio.transcript(c.id, 1)[0];
      return { feedId: c.id, label: c.channel, freqs: c.freqs, status: c.status, lastCall: last ? { text: last.event.text, agoS: Math.round((now - last.at) / 1000) } : null };
    }),
    listeningTo: listener.connected(),
  };
}

/** Start a question, or say on the HUD why that isn't possible. */
function talk(how: string) {
  console.info(`[voice] ${how}; Mac server ${serverHealth ? 'reachable' : 'NOT reachable'}`);
  if (serverHealth) void assistant.listen();
  else assistant.unavailable(`Voice needs the Mac server, and I can't reach it at ${macServer.url()}. Is mac-server/run.sh running and the phone plugged in?`);
}

/** Tip your head to one side and hold: start a question. */
const tilt = createTiltTrigger((rollDeg) => talk(`head tilt (${Math.round(rollDeg)}°)`));

async function checkServer() {
  if (!view || suspended) return;
  serverHealth = await macServer.health();
  void refreshWind();
}

/** The voice line of the info display: is the server there, and how the last question went. */
function voiceInfo(): string {
  const tilted = DEV ? '' : ` · ${tilt.describe(orientation?.get()?.rollDeg ?? null)}`;
  if (!serverHealth) return `voice: Mac server not reachable at ${macServer.url()}${tilted}`;
  const voice = serverHealth.tts === 'ready' ? 'Mac voice' : `phone voice (Mac voice ${serverHealth.tts})`;
  const parts = [`voice: server ok, whisper ${serverHealth.whisper}, ${voice}${serverHealth.aivana ? '' : ', no Aivana key'}`];
  if (serverHealth.tokenNeeded && !appSettings.serverToken) parts.push('needs a server token (settings)');
  const t = lastExchange?.timings;
  if (lastExchange && t) {
    parts.push(`last: ${lastExchange.source} ${t.totalMs ?? '?'} ms (whisper ${t.whisperMs ?? 0}${t.llmMs ? `, llm ${t.llmMs}` : ''}${t.ttsMs ? `, voice ${t.ttsMs}` : ''})`);
  }
  return parts.join(' · ') + tilted + ` · RWY ${runwayInUse()} (${runwaySource()}) · ${radio.describe()}`;
}

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
  // Pattern legs: classified from the AR feed's planes, written onto their cards and the radar.
  const nearPlanes = feedState?.planes ?? [];
  const seenRunway = runwayDetector.current()?.ident;
  const detected = runwayDetector.update(nearPlanes, Date.now());
  if (detected && detected.ident !== seenRunway && appSettings.activeRunway === AUTO_RUNWAY) {
    console.info(`[pattern] runway ${detected.ident} in use (${runwaySource()})`);
    showToast(`Runway ${detected.ident} in use (${detected.by})`);
  }
  const activeRunway = runwayInUse();
  pattern.update(nearPlanes, activeRunway, Date.now());
  const legCodes: Record<string, string> = {};
  const planes = nearPlanes.map((p) => {
    const leg = pattern.legOf(p.id)?.leg;
    // What the plane itself said on the radio, next to what the app worked out: a mismatch is worth seeing.
    const said = radio.reportedLeg(p.id);
    // Who it's probably talking to (or was heard talking to), on a line of its own.
    const talkingTo = appSettings.radioCalls ? (planeRadio(p)?.line ?? null) : null;
    // Where it left from, for a plane with no route. Not in the pattern: that line says more.
    const from = !leg && !p.onGround && routeless(p) ? departures.line(p.id, Date.now()) : null;
    if (!leg && !said && !talkingTo && !from) return p;
    const code = leg && legCode(leg);
    if (code) legCodes[p.id] = code;
    const inPattern = [leg && legLabel(leg, runwayEnd(AIRPORT, activeRunway)), said && `📻 said ${said}`].filter(Boolean).join(' · ');
    return { ...p, note: [inPattern, from, talkingTo].filter(Boolean).join('\n') };
  });
  const shown = applySkyFilter(planes, skyFilter);
  const viewer = gps?.get() ?? null;
  const field = viewer ? airportView(viewer, activeRunway) : null;
  const listView = list.view();
  const opened = listView?.opened ?? null;
  const hud: HudState = {
    headingDeg: currentHeading(),
    halfTan,
    // Only the AR feed's planes get compass icons and sky brackets, however much the list holds,
    // and of those only what the sky filter lets through.
    planes: shown,
    status: feedState?.status ?? '',
    timeMs: performance.now(),
    voice: assistant.hud(),
    pitchDeg: currentPitch(),
    viewerAltM: viewerAltM(),
    // At the field the radar zooms in on the pattern (unless a range was asked for); the list's
    // radar (below) fits its own planes instead.
    radarRangeKm: radarRangeKm ?? field?.patternRadarKm ?? null,
    airport: field ? { ...field.overlay, legCodes } : null,
  };
  // The compass bar and the sky only carry planes within the AR radius. When that's empty but the
  // list (and its radar) holds planes farther out, say so: a bare "No planes" next to a radar full
  // of dots reads as a fault.
  if (skyFilter && !shown.length && planes.length) {
    // The filter is why the sky is empty: say that, and how to undo it.
    hud.emptyText = `No ${skyFilterLabel(skyFilter)} within ${Math.round(traffic?.arRadiusKm ?? DEFAULT_RADIUS_KM)} km · ${planes.length} other${planes.length === 1 ? '' : 's'} hidden (say “show everything in the sky”)`;
  } else if (!planes.length && feedState?.status.startsWith('live')) {
    const fartherOut = traffic?.all().length ?? 0;
    const within = `No planes within ${Math.round(traffic?.arRadiusKm ?? DEFAULT_RADIUS_KM)} km`;
    hud.emptyText = fartherOut ? `${within} · ${fartherOut} farther out are in the list ☰` : `${within} · ${feedState.status}`;
  }
  // Looking straight at the plane you opened: the panel steps aside (it would sit on top of the
  // plane) and the regular card under its bracket takes over until you look away.
  const lookingAtOpened = !!opened && opened.inAr && lastFocusId === opened.plane.id;
  const showPanel = !!listView && !lookingAtOpened;
  // Planes just named on the radio get the same pulsing ring as a plane opened from the list.
  const heard = radio.highlightIds();
  if (heard.length) hud.highlightIds = heard;
  if (listView) {
    // The list's panel takes the card's place, and the radar shows what the list holds.
    hud.showCard = !showPanel;
    if (radarRangeKm == null) hud.radarRangeKm = null;
    const openedShown = !opened || opened.lost || listView.matched.some((p) => p.id === opened.plane.id);
    hud.radarPlanes = openedShown ? listView.matched : [...listView.matched, opened!.plane];
    if (opened && !opened.lost) {
      hud.highlightIds = [...new Set([opened.plane.id, ...heard])];
      if (opened.inAr) hud.guideId = opened.plane.id;
    }
  }
  // Controllers on the compass bar, at their bearing, with a dot for whether they can be listened to.
  if (appSettings.radioCalls && viewer) hud.stations = stations.build(viewer, stationInfo);
  // Connected to a frequency: a pill at the top, and its transcript where the radar is otherwise.
  const listening = listener.state();
  let connectedView: ConnectedView | null = null;
  if (listening) {
    const feed = radio.feed(listening.feedId);
    const facility = facilityOfFeed(feed);
    const chans = facility ? channels(facility) : [];
    // A controller with several channels: one plays, and the transcript can run all of them together.
    const all = chans.length > 1 && !!tuned?.all;
    connectedView = {
      name: facility?.name ?? feed?.name ?? listening.feedId,
      channel: chans.length > 1 ? (feed?.channel ?? null) : null,
      live: feed?.status === 'online',
      muted: !listening.audio,
      lines: !listening.transcript ? null : all ? radio.merged(chans.map((c) => c.id), 4) : radio.transcript(listening.feedId, 4),
      // In a combined transcript each line says which channel it came from.
      tagFor: all ? (feedId) => radio.feed(feedId)?.tag || radio.feed(feedId)?.channel || null : undefined,
      channelsLive: all ? chans.filter((c) => c.status === 'online').length : null,
    };
  }
  const transcriptShowing = !!connectedView?.lines && !showPanel;
  if (transcriptShowing) hud.hideRadar = true;
  const voiceShowing = !!(hud.voice?.answer || hud.voice?.transcript);
  // The radio goes silent while the assistant listens (the microphone would hear it) and low while it thinks and talks.
  const voiceState = hud.voice?.state ?? 'idle';
  listener.duck(voiceState === 'listening' ? 0 : voiceState === 'idle' ? 1 : 0.2);
  // The list's left edge runs through the middle of the view: no crosshair while it's open.
  const radioCall = radio.latest();
  stereoEl.classList.toggle('list-open', showPanel);
  listBtn.classList.toggle('on', !!listView);
  // Both eyes get identical input (required for the images to fuse).
  for (const eye of view.eyes) {
    lastHud = drawHud(eye.ctx, width, height, hud);
    lastFocusId = lastHud.focus?.id ?? null;
    if (listView && showPanel) drawList(eye.ctx, width, height, listView, hud.headingDeg, hud.timeMs);
    if (skyFilter) drawSkyFilterChip(eye.ctx, width, height, skyFilter);
    if (connectedView) drawConnected(eye.ctx, width, height, connectedView, transcriptShowing && !voiceShowing);
    // The one-line subtitle is for when no transcript is on screen (it would say the same thing twice).
    if (radioCall && !transcriptShowing) drawRadio(eye.ctx, width, height, radioCall, traffic?.arRadiusKm ?? DEFAULT_RADIUS_KM);
  }
  if (!DEV) tilt.update(orientation?.get()?.rollDeg ?? null, hud.timeMs);
}

/** The overlay is built as HTML: anything that isn't our own fixed text (server replies, settings, device labels) goes through this. */
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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
    debug = `<div class="debug">${hdg} · ${decl} · fov ${Math.round(lastHalfFovDeg * 2)}° (lens ${escapeHtml(lensInfo)}) · ${escapeHtml(traffic?.near.get().status ?? '')} · ${escapeHtml(wideInfo())}<br>
      ${escapeHtml(voiceInfo())}<br>
      ${screenInfo} · tilt ${settings.tiltDeg}° · ${settings.ipdMm}mm · shift ${settings.offsetMm}mm · ${Math.round(settings.viewScale * 100)}% · ${stream ? escapeHtml(describeStream(stream)) : 'no camera'}</div>`;
  }
  const error = hudError ? `<div class="hud-error">${escapeHtml(hudError)}</div>` : '';
  const toastHtml = toast ? `<div class="toast">${escapeHtml(toast)}</div>` : '';
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
  if (appSettings.radioCalls) radio.start();
  listener.resume();
}

function stopTracking() {
  orientation?.stop();
  traffic?.stop();
  radio.stop();
  listener.pause();
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

    // The microphone prompt has to come now, while the phone is still in your hand.
    if (!DEV) await requestMicrophone();
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
    void checkServer();
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
  assistant.cancel();
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
  assistant.cancel();
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
// Two fingers down at once = talk: the phone-in-hand way to ask a question (in the headset it's the head tilt).
stereoEl.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 2) return;
    clearTimeout(longPressTimer);
    if (assistant.busy()) assistant.finish();
    else talk('two-finger tap');
  },
  { passive: true },
);
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
  // V = ask a question (again = stop and send). The list keys work without the Mac server.
  else if (e.key === 'v' || e.key === 'V') {
    if (assistant.busy()) assistant.finish();
    else void assistant.listen();
  } else if (e.key === 'l' || e.key === 'L') toggleList();
  // S = the list's filter on the sky (again = off).
  else if (e.key === 's' || e.key === 'S') skyFilter = skyFilter ? null : skyFilterFrom(list.state().filter);
  // C = listen to the controller in the middle of the view (again = stop). M = mute, T = transcript.
  else if (e.key === 'c' || e.key === 'C') {
    const feedId = lastHud.station && stationBrief(lastHud.station.id)?.feedId;
    if (listener.connected()) disconnectRadio();
    else if (feedId) showToast(connectFeed(feedId) ?? 'Connected');
  } else if (e.key === 'm' || e.key === 'M') listener.audio(listener.state()?.audio ? 'off' : 'on');
  else if (e.key === 't' || e.key === 'T') listener.transcript(listener.state()?.transcript ? 'hide' : 'show');
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
// Desktop dev mode keeps running when its tab is hidden: an embedded preview hides and shows the
// page as tools look at it, which would restart tracking (and lose the traffic) every time.
if (!DEV) handlePauseResume(suspend, resume);
// Keep the info line's heading fresh while it's showing.
setInterval(() => {
  if (view && mode === 'info') renderOverlay();
}, 500);
// Is the Mac server there? (Head-tilt only listens when it is.)
setInterval(checkServer, 8000);

/** The plane being looked at and since when, and when each plane's origin was last asked of the Mac. */
let heldFocus: { id: string; sinceMs: number } | null = null;
const originAskedAt = new Map<string, number>();
const AIRFIELD_KINDS = ['L', 'M', 'S', 'P', 'H'];
/**
 * For a plane with no route that the app never saw on the ground: ask the Mac, which reads the
 * start of OpenSky's track. Only for a plane looked at for a couple of seconds, and once a quarter
 * of an hour per plane: OpenSky allows a limited number of requests a day.
 */
function askOrigin(nowMs: number) {
  const p = lastHud.focus;
  if (!p) return void (heldFocus = null);
  if (heldFocus?.id !== p.id) return void (heldFocus = { id: p.id, sinceMs: nowMs });
  if (nowMs - heldFocus.sinceMs < 2000 || !serverHealth || p.onGround || !routeless(p) || !/^[0-9a-f]{6}$/.test(p.id)) return;
  // Known already, unless all the app has is "seen leaving" (a touch-and-go says nothing about where it started).
  const known = departures.of(p.id, nowMs);
  if (departures.at(p.id) || (known && known.how !== 'leaving')) return;
  if (nowMs - (originAskedAt.get(p.id) ?? 0) < 15 * 60_000) return;
  originAskedAt.set(p.id, nowMs);
  void macServer.origin(p.id, p.kind === 'helicopter').then((o) => {
    if (!o) return;
    const kind = (AIRFIELD_KINDS.includes(o.kind) ? o.kind : 'S') as AirfieldKind;
    departures.set(p.id, { field: { code: o.code, name: o.name, city: o.city, kind, lat: o.lat, lon: o.lon }, atMs: o.atS * 1000, how: o.exact ? 'from' : 'near', source: 'opensky' }, Date.now());
  });
}
// Departures: watch every known plane (near and wide) for leaving an airfield.
setInterval(() => {
  if (!traffic) return;
  const now = Date.now();
  departures.update(traffic.all(), now);
  askOrigin(now);
}, 2000);
// For testing from a console (desktop, or chrome://inspect on the phone): bombirdier.ask('show me the helicopters').
(window as any).bombirdier = {
  ask: (text: string) => assistant.askText(text),
  listen: () => assistant.listen(),
  context: voiceContext,
  /** Every plane the app knows the departure airfield of, as its card would say it. */
  departures: () => departures.known(Date.now()),
  debug: () => ({ server: serverHealth, radio: radio.describe(), listening: listener.state(), station: lastHud.station?.id ?? null, focus: lastHud.focus ? { name: lastHud.focus.callsign ?? lastHud.focus.registration, note: lastHud.focus.note ?? null } : null, heard: radio.latest()?.event.text ?? null, highlighted: radio.highlightIds(), voice: assistant.hud(), rollDeg: orientation?.get()?.rollDeg ?? null, tilt: tilt.describe(orientation?.get()?.rollDeg ?? null) }),
};

// Straight into the view on launch; settings only show if it can't start (e.g. camera denied).
initSettings().then(start);
