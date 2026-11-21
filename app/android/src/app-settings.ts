// Settings that only Bombirdier has. Kept apart from web/src/config.ts's Settings (shared with the
// original web app) and stored under their own key.

import { WOOD_COUNTY } from './airports/1g0';
import type { WideMode } from './traffic/wide';

export type AppSettings = {
  /** The 250 nm list data: always, only on Wi-Fi, or never (the list then shows the AR planes). */
  wideTraffic: WideMode;
  /**
   * Runway in use at Wood County: decides which traffic pattern is drawn and how legs are named.
   * "auto" = worked out from the traffic (pattern/runway.ts), starting from the calm-wind runway;
   * or a runway ("28") to force it.
   */
  activeRunway: string;
  /** True once the user (or a voice command) has picked a runway by hand. */
  activeRunwayChosen?: boolean;
  /** Listen for radio calls on the Mac's live feed and point out the plane being talked to. */
  radioCalls: boolean;
  /** Where the Mac server (voice assistant) is. The default works over USB after `adb reverse tcp:8787 tcp:8787`. */
  serverUrl: string;
  /** Shared secret the Mac server asks for over Wi-Fi (BOMBIRDIER_TOKEN in mac-server/.env). Not needed over USB. */
  serverToken: string;
};

export const AUTO_RUNWAY = 'auto';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  wideTraffic: 'on',
  activeRunway: AUTO_RUNWAY,
  radioCalls: true,
  serverUrl: 'http://localhost:8787',
  serverToken: '',
};

const STORAGE_KEY = 'bombirdier-settings-v1';
const WIDE_MODES: WideMode[] = ['on', 'wifi', 'off'];

export function loadAppSettings(): AppSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AppSettings>;
    return {
      wideTraffic: WIDE_MODES.includes(saved.wideTraffic as WideMode) ? saved.wideTraffic! : DEFAULT_APP_SETTINGS.wideTraffic,
      // A runway saved before "auto" existed was the old default (28), not a choice: only an explicit
      // choice made since (activeRunwayChosen) is kept.
      activeRunway:
        saved.activeRunwayChosen && WOOD_COUNTY.runways.some((r) => r.ident === saved.activeRunway) ? saved.activeRunway! : DEFAULT_APP_SETTINGS.activeRunway,
      activeRunwayChosen: saved.activeRunwayChosen === true,
      radioCalls: saved.radioCalls !== false,
      serverUrl: typeof saved.serverUrl === 'string' && /^https?:\/\//.test(saved.serverUrl) ? saved.serverUrl : DEFAULT_APP_SETTINGS.serverUrl,
      serverToken: typeof saved.serverToken === 'string' ? saved.serverToken.slice(0, 200) : '',
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(s: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable; settings just won't persist.
  }
}
