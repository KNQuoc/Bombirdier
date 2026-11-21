// Settings that only Bombirdier has. Kept apart from web/src/config.ts's Settings (shared with the
// original web app) and stored under their own key.

import { WOOD_COUNTY } from './airports/1g0';
import type { WideMode } from './traffic/wide';

export type AppSettings = {
  /** The 250 nm list data: always, only on Wi-Fi, or never (the list then shows the AR planes). */
  wideTraffic: WideMode;
  /** Runway in use at Wood County ("28"): decides which traffic pattern is drawn and how legs are named. */
  activeRunway: string;
};

export const DEFAULT_APP_SETTINGS: AppSettings = { wideTraffic: 'on', activeRunway: WOOD_COUNTY.defaultRunway };

const STORAGE_KEY = 'bombirdier-settings-v1';
const WIDE_MODES: WideMode[] = ['on', 'wifi', 'off'];

export function loadAppSettings(): AppSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AppSettings>;
    return {
      wideTraffic: WIDE_MODES.includes(saved.wideTraffic as WideMode) ? saved.wideTraffic! : DEFAULT_APP_SETTINGS.wideTraffic,
      activeRunway: WOOD_COUNTY.runways.some((r) => r.ident === saved.activeRunway) ? saved.activeRunway! : DEFAULT_APP_SETTINGS.activeRunway,
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
