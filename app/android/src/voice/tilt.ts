// Head-tilt push-to-talk. With the phone in a headset you can't touch the screen, so tipping your
// head to one side and holding it there starts a question.

/** Tilt past this, in degrees, to arm the trigger... */
const TILT_DEG = 30;
/** ...hold it this long to fire... */
const HOLD_MS = 800;
/** ...and come back to within this of level before it can fire again. */
const LEVEL_DEG = 15;
/**
 * A phone held upright in your hand (portrait) reads as a near-90 degree tilt. Past this it's not a
 * head tilt, so it never fires: nobody tips their head that far.
 */
const NOT_A_HEAD_DEG = 65;

export function createTiltTrigger(onTrigger: (rollDeg: number) => void) {
  let tiltedSince: number | null = null;
  let armed = true;
  return {
    /** For the info line: what the trigger is waiting for. */
    describe(rollDeg: number | null): string {
      if (rollDeg == null) return 'tilt: no sensor';
      const tilt = Math.abs(rollDeg);
      const state = tilt > NOT_A_HEAD_DEG ? 'too far (hold the phone in landscape)' : tilt >= TILT_DEG ? (armed ? 'holding…' : 'fired, level out to re-arm') : `tilt past ${TILT_DEG}° to talk`;
      return `tilt ${Math.round(rollDeg)}° · ${state}`;
    },
    /** Call every frame with the current sideways tilt (null = unknown). */
    update(rollDeg: number | null, nowMs: number) {
      const tilt = rollDeg == null ? 0 : Math.abs(rollDeg);
      if (tilt < LEVEL_DEG) armed = true;
      if (tilt < TILT_DEG || tilt > NOT_A_HEAD_DEG) {
        tiltedSince = null;
        return;
      }
      tiltedSince ??= nowMs;
      if (armed && nowMs - tiltedSince >= HOLD_MS) {
        armed = false;
        tiltedSince = null;
        onTrigger(rollDeg ?? 0);
      }
    },
  };
}
