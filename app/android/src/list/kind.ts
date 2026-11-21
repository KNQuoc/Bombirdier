// Jet or propeller? ADS-B doesn't say, so this goes by the ICAO type designator, then falls back
// to the emitter category and how the aircraft is flying. A heuristic: good for "show me the jets",
// not for anything that matters.

import type { Plane } from '@web/planes';

export type EngineKind = 'jet' | 'prop';

/** Piston singles and twins, and turboprops, by ICAO type designator. */
const PROP_TYPES = new Set(
  (
    // Piston singles
    'C150 C152 C162 C170 C172 C175 C177 C180 C182 C185 C195 C205 C206 C207 C210 C72R C77R C82R T206 T210 ' +
    'P28A P28B P28R P28S P28T P28U P32R P32T PA18 PA20 PA22 PA24 PA25 PA28 PA32 PA38 PA46 PA11 PA12 J3 ' +
    'SR20 SR22 S22T DA20 DA40 DV20 BE23 BE24 BE33 BE35 BE36 M20P M20T AA1 AA5 COL3 COL4 TB9 TB10 TB20 TB21 ' +
    'RV4 RV6 RV7 RV8 RV9 RV10 RV12 RV14 GLAS LNC2 LNC4 NAVI HUSK BL8 CH7A CH7B CH60 CH75 AC11 AC14 DHC2 DHC3 ' +
    'C120 C140 ERCO LUSC TAYB CRUZ SLG2 E300 EXTR PTS2 T6 T28 T34P BN2P GA8 ' +
    // Piston twins
    'PA23 PA27 PA30 PA31 PA34 PA39 PA44 PA60 BE50 BE55 BE56 BE58 BE60 BE76 BE95 C303 C310 C320 C335 C337 ' +
    'C340 C401 C402 C404 C411 C414 C421 DA42 DA62 P68 AEST AC50 AC56 AC68 TECN P06T DC3 ' +
    // Turboprops
    'BE9L BE9T BE10 BE20 BE30 B350 B190 BE99 B36T C208 C425 C441 PC6T PC7 PC9 PC12 PC21 TBM7 TBM8 TBM9 ' +
    'P46T PAY1 PAY2 PAY3 PAY4 PA42 KODI EPIC EVOT MU2 P180 AC90 AC95 SW2 SW3 SW4 JS31 JS32 JS41 ' +
    'AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76 DH8A DH8B DH8C DH8D DHC6 DHC7 SF34 SB20 E110 E120 D228 D328 ' +
    'F27 F50 L410 SH33 SH36 C212 CN35 C295 AN12 AN24 AN26 AN32 L188 A748 CVLT CL2T AT8T AT5T AT6T AT3T ' +
    // Military props
    'C130 C30J C160 A400 P3 E2 C2 TEX2 T34T V22'
  ).split(' '),
);

/** Jets whose designators don't fit the patterns below. */
const JET_TYPES = new Set(
  (
    'B38M B39M B37M B3XM B461 B462 B463 B52 B1 B2 A124 A148 A158 A225 BCS1 BCS3 SU95 F100 F70 F28 RJ70 RJ85 ' +
    'RJ1H J328 IL76 IL96 IL62 T134 T154 T204 C17 C5M K35R K35E KC10 E3TF E3CF E6 E8 P8 C40 C32 C37 R135 ' +
    'F15 F16 F18 F18H F18S F22 F35 A10 T38 T45 U2 L39 HAWK EUFI F5 F4 H25A H25B H25C BE40 PRM1 HA4T PC24 ' +
    'HDJT SF50 EA50 GALX ASTR GLEX WW24 SBR1 SBR2 MU30 B712'
  ).split(' '),
);

const JET_PATTERNS = [
  /^A3\d[0-9A-Z]$/, // Airbus A300-A380
  /^A(19|20|21)N$/, // A320neo family
  /^B7\d[0-9A-Z]$/, // Boeing 7x7
  /^CRJ/, // Bombardier CRJ
  /^E(1[3-9]\d|2\d\d|35L|45X|50P|55P|545|550|75[LS])$/, // Embraer jets (E110/E120 are props)
  /^C(25[ABCM]|5[0-9][0-9B]|56X|6[58]0|68A|700|750)$/, // Cessna Citation
  /^(CL\d\d|GL\dT)$/, // Challenger, Global
  /^(GLF\d|G1[05]0|G2[08]0|GA\dC)$/, // Gulfstream
  /^LJ\d\d$/, // Learjet
  /^(F2TH|F900|FA\d\w)$/, // Dassault Falcon
  /^(MD\d\d|DC\d\d)$/, // McDonnell Douglas jets (the DC-3 is "DC3")
];

/** Above these, an unidentified aircraft is almost certainly a jet. */
const JET_SPEED_KT = 250;
const JET_ALT_FT = 25_000;

/** 'jet', 'prop', or null for helicopters and things that are neither (gliders, balloons, ground vehicles). */
export function engineKind(p: Plane): EngineKind | null {
  if (p.kind === 'helicopter') return null;
  const type = p.typeCode?.toUpperCase();
  if (type) {
    if (PROP_TYPES.has(type)) return 'prop';
    if (JET_TYPES.has(type) || JET_PATTERNS.some((re) => re.test(type))) return 'jet';
  }
  const category = p.category ?? '';
  // B = gliders, balloons, drones...; C = surface vehicles and obstacles.
  if (/^[BCD]/.test(category)) return null;
  if (/^A[3456]$/.test(category)) return 'jet'; // large, heavy, high performance
  if (category === 'A1') return 'prop'; // light (< 15,500 lb)
  const fast = (p.groundSpeedKt ?? 0) > JET_SPEED_KT || (p.altitudeFt ?? 0) > JET_ALT_FT;
  if (fast) return 'jet';
  // A2 (small) or unknown: slow and low reads as a prop, if it's moving at all.
  return p.groundSpeedKt != null || category === 'A2' ? 'prop' : null;
}
