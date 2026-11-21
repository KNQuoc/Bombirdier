// Angle helpers and the camera projection used to place labels.
// Conventions (see CLAUDE.md): degrees, clockwise from true north, [0, 360).

export const toRad = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;

export const normalizeDeg = (d: number) => ((d % 360) + 360) % 360;

/** Signed angle from `from` to `target` in (-180, 180]. Negative = target is to the left. */
export const signedDiffDeg = (target: number, from: number) => ((((target - from + 540) % 360) + 360) % 360) - 180;

/**
 * tan(horizontal half-FOV) of what one eye actually shows.
 * Starts from the phone's main camera at 1x, divides by hardware zoom, then accounts for
 * `object-fit: cover` cropping the sides when the eye is narrower than the stream.
 */
export function visibleHalfTan(
  baseHalfTan1x: number,
  zoom: number,
  eyeAspect: number,
  streamAspect: number,
  fovScale: number,
): number {
  const crop = Math.min(1, eyeAspect / streamAspect);
  return (baseHalfTan1x / zoom) * crop * fovScale;
}

export const halfFovDeg = (halfTan: number) => toDeg(Math.atan(halfTan));

const EARTH_RADIUS_M = 6_371_000;

/**
 * Angle above the horizon (degrees) of something `heightDiffM` above the viewer and `distanceKm`
 * away along the ground. Includes Earth's curvature (it drops ~31 m at 20 km).
 */
export function elevationDeg(heightDiffM: number, distanceKm: number): number {
  const d = Math.max(1, distanceKm * 1000);
  const drop = (d * d) / (2 * EARTH_RADIUS_M);
  return toDeg(Math.atan2(heightDiffM - drop, d));
}

export type SkyPoint = {
  x: number;
  y: number;
  /** Angle between the view center and this direction (degrees), for picking the focused plane. */
  offCenterDeg: number;
};

/**
 * Full pinhole projection of a direction in the sky (bearing + elevation) into an eye of w×h px,
 * for a camera looking along `headingDeg` (true north) tilted up by `pitchDeg`. Roll is ignored (the
 * in-headset tilt calibration handles a crooked phone). Square pixels, so the vertical half-FOV is
 * halfTan * h / w. With pitch = 0 and elevation = 0, x matches projectX(). null = behind the viewer
 * or too far off-axis to place.
 */
export function projectSky(
  bearing: number,
  elevation: number,
  headingDeg: number,
  pitchDeg: number,
  halfTan: number,
  w: number,
  h: number,
): SkyPoint | null {
  const [b, e, hd, pt] = [toRad(bearing), toRad(elevation), toRad(headingDeg), toRad(pitchDeg)];
  // Unit vectors in East-North-Up.
  const dir = [Math.cos(e) * Math.sin(b), Math.cos(e) * Math.cos(b), Math.sin(e)];
  const fwd = [Math.cos(pt) * Math.sin(hd), Math.cos(pt) * Math.cos(hd), Math.sin(pt)];
  const right = [Math.cos(hd), -Math.sin(hd), 0];
  const up = [-Math.sin(pt) * Math.sin(hd), -Math.sin(pt) * Math.cos(hd), Math.cos(pt)];
  const dot = (a: number[], c: number[]) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];

  const depth = dot(dir, fwd);
  if (depth < 0.05) return null; // behind, or > ~87° off-axis
  const vHalfTan = halfTan * (h / w);
  return {
    x: w / 2 + (dot(dir, right) / depth / halfTan) * (w / 2),
    y: h / 2 - (dot(dir, up) / depth / vHalfTan) * (h / 2),
    offCenterDeg: toDeg(Math.acos(Math.min(1, depth))),
  };
}

/** Pinhole projection of a horizontal angle off-center to an x coordinate in an eye of `width`. */
export function projectX(offsetDeg: number, halfTan: number, width: number): number | null {
  if (Math.abs(offsetDeg) >= 89) return null;
  return width / 2 + (Math.tan(toRad(offsetDeg)) / halfTan) * (width / 2);
}
