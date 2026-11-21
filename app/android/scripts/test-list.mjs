// Unit tests for the list view's logic (src/list) and the route parsing it relies on.
//   npm test
// Hand-made planes only: no network, no recorded traffic. Add `-- --data <adsb.lol point JSON>` to
// also print how a real response splits into jets / props / helicopters / unclassified.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'error',
});

let failed = 0;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`);
  }
}

/** A plane 10 km north at 5,000 ft unless told otherwise. */
const plane = (over = {}) => ({
  id: 'abc123', callsign: null, registration: null, typeCode: null, typeName: null, airline: null,
  origin: null, destination: null, lat: 41.48, lon: -83.63, altitudeFt: 5000, altitudeGeomFt: 5200,
  groundSpeedKt: 120, trackDeg: 90, verticalRateFpm: 0, distanceKm: 10, bearingDeg: 0,
  category: null, kind: 'plane', onGround: false, emergency: null, military: false, medical: false,
  ...over,
});

try {
  const { engineKind } = await vite.ssrLoadModule('/src/list/kind.ts');
  const F = await vite.ssrLoadModule('/src/list/filter.ts');
  const L = await vite.ssrLoadModule('/src/list/list.ts');
  const adsb = await vite.ssrLoadModule('/src/flights/adsb.ts');
  const nearby = await vite.ssrLoadModule('/src/flights/nearby.ts');
  const bgsu = await vite.ssrLoadModule('/src/fleet/bgsu.ts');

  test('engineKind by type designator', () => {
    for (const t of ['C172', 'P28A', 'PA44', 'SR22', 'DH8D', 'AT76', 'B350', 'PC12', 'C130']) {
      assert.equal(engineKind(plane({ typeCode: t })), 'prop', t);
    }
    for (const t of ['B738', 'B38M', 'A320', 'A21N', 'CRJ9', 'E75L', 'E145', 'C56X', 'C25B', 'GLF5', 'LJ45', 'F2TH', 'MD11', 'B77W', 'CL35']) {
      assert.equal(engineKind(plane({ typeCode: t })), 'jet', t);
    }
    // A prop designator wins over a jet-looking category.
    assert.equal(engineKind(plane({ typeCode: 'DH8D', category: 'A3' })), 'prop');
  });

  test('engineKind fallbacks', () => {
    assert.equal(engineKind(plane({ kind: 'helicopter', typeCode: 'EC35' })), null);
    assert.equal(engineKind(plane({ category: 'A5' })), 'jet');
    assert.equal(engineKind(plane({ category: 'A1' })), 'prop');
    assert.equal(engineKind(plane({ category: 'C2', groundSpeedKt: 10 })), null); // ground vehicle
    assert.equal(engineKind(plane({ category: 'B1' })), null); // glider
    assert.equal(engineKind(plane({ category: 'A2', altitudeFt: 38000, groundSpeedKt: 420 })), 'jet');
    assert.equal(engineKind(plane({ category: 'A2', altitudeFt: 9000, groundSpeedKt: 190 })), 'prop');
    assert.equal(engineKind(plane({ groundSpeedKt: null, altitudeFt: null })), null);
  });

  test('sanitizeFilter keeps valid fields and drops the rest', () => {
    assert.deepEqual(
      F.sanitizeFilter({ kind: 'jets', airline: ' swa ', minAltFt: 30000, sort: 'altitude', order: 'desc', page: 2 }),
      { kind: 'jets', airline: 'SWA', minAltFt: 30000, sort: 'altitude', order: 'desc', page: 2 },
    );
    assert.deepEqual(
      F.sanitizeFilter({ kind: 'spaceships', airline: 42, minAltFt: -5, maxAltFt: 'high', climbing: 'yes', onGround: true, sort: 'color', page: -1, evil: 1 }),
      {},
    );
    assert.deepEqual(F.sanitizeFilter(null), {});
    assert.deepEqual(F.sanitizeFilter('helicopters'), {});
    assert.deepEqual(F.sanitizeFilter({ query: 'n901-bg!!', onGround: 'only', climbing: true }), { query: 'N901-BG', onGround: 'only', climbing: true });
  });

  const fleet = [
    plane({ id: 'a1', callsign: 'SWA1234', typeCode: 'B738', altitudeFt: 36000, groundSpeedKt: 450, distanceKm: 300 }),
    plane({ id: 'a2', callsign: 'SWA88', typeCode: 'B38M', altitudeFt: 12000, groundSpeedKt: 300, distanceKm: 60, verticalRateFpm: -1800 }),
    plane({ id: 'a3', callsign: 'DAL1830', typeCode: 'A321', altitudeFt: 31000, groundSpeedKt: 470, distanceKm: 120, verticalRateFpm: 900 }),
    plane({ id: 'a4', callsign: 'N901BG', registration: 'N901BG', typeCode: 'P28A', altitudeFt: 1700, groundSpeedKt: 95, distanceKm: 2 }),
    plane({ id: 'a5', callsign: 'N905BG', registration: 'N905BG', typeCode: 'PA44', altitudeFt: 0, groundSpeedKt: 8, distanceKm: 1, onGround: true }),
    plane({ id: 'a6', callsign: 'LIFE5', typeCode: 'EC35', kind: 'helicopter', medical: true, altitudeFt: 1500, distanceKm: 25 }),
    plane({ id: 'a7', callsign: 'RCH402', typeCode: 'C17', military: true, altitudeFt: 28000, groundSpeedKt: 430, distanceKm: 200 }),
    plane({ id: 'a8', callsign: null, registration: null, typeCode: null, altitudeFt: null, groundSpeedKt: null, distanceKm: 80 }),
  ];
  const ids = (f) => F.applyFilter(fleet, f).map((p) => p.id);

  test('BGSU fleet: tail number plus a propeller type', () => {
    const tail = (registration, over = {}) => plane({ registration, callsign: registration, ...over });
    assert.equal(bgsu.isBgsu(tail('N337BG', { typeCode: 'P28A' })), true);
    assert.equal(bgsu.isBgsu(tail('N442BG', { typeCode: 'PA44' })), true);
    assert.equal(bgsu.isBgsu(tail('N901BG', { typeCode: 'P28A' })), true);
    assert.equal(bgsu.isBgsu(tail('N905BG', { typeCode: null })), true); // type missing from the database
    assert.equal(bgsu.isBgsu(plane({ registration: null, callsign: 'N901BG', typeCode: 'P28A' })), true); // callsign only
    assert.equal(bgsu.isBgsu(tail('N501BG', { typeCode: 'CRJ7' })), false); // a regional jet that happens to end in BG
    assert.equal(bgsu.isBgsu(tail('N72HP', { typeCode: 'P28A' })), false);
    assert.equal(bgsu.isBgsu(tail('N1234BG', { typeCode: 'P28A' })), false); // four digits: not the BGSU scheme
    assert.equal(bgsu.isBgsu(plane({ callsign: 'SWA1234', typeCode: 'B738' })), false);
    const [a, b] = bgsu.tagFleet([tail('N337BG', { typeCode: 'P28A' }), tail('N72HP', { typeCode: 'C172' })]);
    assert.deepEqual([a.tag, a.accent, b.tag], ['BGSU', bgsu.BGSU_COLOR, undefined]);
  });

  test('BGSU filter includes planes on the ground by default', () => {
    const home = bgsu.tagFleet(fleet.map((p) => ({ ...p })));
    const idsOf = (f) => F.applyFilter(home, f).map((p) => p.id);
    assert.deepEqual(idsOf({ fleet: 'bgsu' }), ['a5', 'a4']); // N905BG taxiing, N901BG in the pattern
    assert.deepEqual(idsOf({ fleet: 'bgsu', onGround: 'hide' }), ['a4']);
    assert.deepEqual(idsOf({ fleet: 'bgsu', onGround: 'only' }), ['a5']);
    assert.deepEqual(idsOf({}), ['a4', 'a6', 'a2', 'a8', 'a3', 'a7', 'a1']); // everyone else unchanged
    assert.deepEqual(F.filterChips({ fleet: 'bgsu', climbing: true }), ['BGSU', '↑ climbing']);
    assert.deepEqual(F.sanitizeFilter({ fleet: 'bgsu' }), { fleet: 'bgsu' });
    assert.deepEqual(F.sanitizeFilter({ fleet: 'delta' }), {});
  });

  test('default list: airborne only, nearest first', () => {
    assert.deepEqual(ids({}), ['a4', 'a6', 'a2', 'a8', 'a3', 'a7', 'a1']);
  });

  test('filters', () => {
    assert.deepEqual(ids({ kind: 'jets' }), ['a2', 'a3', 'a7', 'a1']);
    assert.deepEqual(ids({ kind: 'props' }), ['a4']);
    assert.deepEqual(ids({ kind: 'props', onGround: 'show' }), ['a5', 'a4']);
    assert.deepEqual(ids({ kind: 'helicopters' }), ['a6']);
    assert.deepEqual(ids({ kind: 'military' }), ['a7']);
    assert.deepEqual(ids({ kind: 'medical' }), ['a6']);
    assert.deepEqual(ids({ kind: 'emergencies' }), []);
    assert.deepEqual(ids({ airline: 'SWA' }), ['a2', 'a1']);
    assert.deepEqual(ids({ airline: 'SWA', minAltFt: 30000 }), ['a1']);
    assert.deepEqual(ids({ typeCode: 'A321' }), ['a3']);
    assert.deepEqual(ids({ maxAltFt: 2000 }), ['a4', 'a6']); // unknown altitude is left out
    assert.deepEqual(ids({ maxDistNm: 20 }), ['a4', 'a6']); // 20 nm = 37 km
    assert.deepEqual(ids({ minDistNm: 100 }), ['a7', 'a1']);
    assert.deepEqual(ids({ climbing: true }), ['a3']);
    assert.deepEqual(ids({ descending: true }), ['a2']);
    assert.deepEqual(ids({ climbing: true, descending: true }), ['a2', 'a3']);
    assert.deepEqual(ids({ onGround: 'only' }), ['a5']);
    assert.deepEqual(ids({ query: 'BG', onGround: 'show' }), ['a5', 'a4']);
    assert.deepEqual(ids({ query: '1830' }), ['a3']);
  });

  test('sorting: sensible default direction, unknown values last', () => {
    assert.deepEqual(ids({ sort: 'altitude' }), ['a1', 'a3', 'a7', 'a2', 'a4', 'a6', 'a8']);
    assert.deepEqual(ids({ sort: 'altitude', order: 'asc' }), ['a6', 'a4', 'a2', 'a7', 'a3', 'a1', 'a8']);
    assert.deepEqual(ids({ sort: 'speed' }), ['a3', 'a1', 'a7', 'a2', 'a6', 'a4', 'a8']);
    assert.deepEqual(ids({ sort: 'distance', order: 'desc' })[0], 'a1');
  });

  test('chips', () => {
    assert.deepEqual(F.filterChips({}), []);
    assert.deepEqual(F.filterChips({ kind: 'jets', minAltFt: 30000, airline: 'SWA' }), ['✈ jets', 'SWA', '>30,000 ft']);
    assert.deepEqual(F.filterChips({ sort: 'altitude' }), ['↓ altitude']);
    assert.deepEqual(F.filterChips({ sort: 'distance' }), []);
  });

  test('findPlane: exact, then tail end, nearest wins', () => {
    assert.equal(L.findPlane(fleet, 'swa 1234')?.id, 'a1');
    assert.equal(L.findPlane(fleet, 'N901BG')?.id, 'a4');
    assert.equal(L.findPlane(fleet, '1BG')?.id, 'a4');
    assert.equal(L.findPlane(fleet, 'BG')?.id, 'a5'); // both Wood County planes end in BG: the closer one
    assert.equal(L.findPlane(fleet, 'a7')?.id, 'a7');
    assert.equal(L.findPlane(fleet, 'UAL1'), null);
    assert.equal(L.findPlane(fleet, '  '), null);
  });

  test('where a plane is', () => {
    assert.equal(L.compassWord(0), 'north');
    assert.equal(L.compassWord(292), 'west-northwest');
    assert.equal(L.compassWord(359), 'north');
    // 36,000 ft at 312 km is below the horizon (Earth drops ~7.6 km over that distance, plus the plane is 11 km up).
    assert.equal(L.whereIs(plane({ altitudeGeomFt: 20000, distanceKm: 312, bearingDeg: 292 }), 207), '312 km west-northwest · below horizon');
    assert.equal(L.whereIs(plane({ altitudeGeomFt: 31000, distanceKm: 15.7, bearingDeg: 139 }), 207), '16 km southeast · 30° above the horizon');
    assert.equal(L.whereIs(plane({ altitudeGeomFt: null, altitudeFt: null, distanceKm: 4.2, bearingDeg: 90 }), 207), '4.2 km east');
  });

  test('list controller', () => {
    const many = Array.from({ length: 20 }, (_, i) => plane({ id: `p${i}`, callsign: `UAL${i}`, typeCode: 'B738', distanceKm: i + 1 }));
    const looked = [];
    const list = L.createList({
      planes: () => many,
      coverage: () => ({ radius: '250 nm', ageS: 40, note: '' }),
      viewerAltM: () => 207,
      arRadiusKm: () => 5,
      lookupRoute: (p) => looked.push(p.id),
      routeFor: (cs) => (cs === 'UAL2' ? ['ORD', 'CLE'] : undefined),
    });
    assert.equal(list.view(), null);
    list.show();
    assert.equal(list.view().header, '20 planes · 250 nm · 40s ago');
    assert.equal(list.view().rows.length, 8);
    assert.equal(list.view().pages, 3);
    list.page('next');
    list.page('next');
    list.page('next'); // already on the last page
    assert.equal(list.view().page, 2);
    assert.deepEqual(list.view().rows.map((r) => r.plane.id), ['p16', 'p17', 'p18', 'p19']);
    list.page('prev');
    assert.equal(list.view().page, 1);

    list.setFilter({ maxDistNm: 2, bogus: true });
    assert.equal(list.view().page, 0);
    assert.equal(list.view().header, '3 of 20 planes · 250 nm · 40s ago');
    assert.deepEqual(list.view().chips, ['<2 nm']);
    assert.equal(list.count({ maxDistNm: 1 }), 1);
    assert.equal(list.count({ kind: 'helicopters' }), 0);

    assert.equal(list.openRow(3), true);
    assert.deepEqual(looked, ['p2']);
    const opened = list.view().opened;
    assert.equal(opened.plane.id, 'p2');
    assert.equal(opened.inAr, true);
    assert.equal(opened.lines[1].endsWith('ORD → CLE'), true);
    assert.equal(list.openRow(9), false);
    list.closePlane();
    assert.equal(list.view().opened, null);

    list.clearFilter();
    assert.equal(list.openPlane('ual19').id, 'p19');
    assert.equal(list.view().opened.inAr, false);
    many.pop(); // UAL19 leaves the data
    list.setFilter({});
    list.openPlane('UAL18');
    many.pop();
    list.sort('speed'); // forces a rebuild
    assert.equal(list.view().opened.lost, true);
    list.hide();
    assert.equal(list.view(), null);
    assert.equal(list.state().open, false);
  });

  test('route parsing judges plausibility from the plane position', () => {
    const atl = { iata: 'ATL', icao: 'KATL', lat: 33.6367, lon: -84.4281 };
    const dtw = { iata: 'DTW', icao: 'KDTW', lat: 42.2124, lon: -83.3534 };
    const mia = { iata: 'MIA', icao: 'KMIA', lat: 25.7932, lon: -80.2906 };
    // Near Bowling Green, OH: on the way from Atlanta to Detroit.
    assert.deepEqual(adsb.parseRoute({ _airports: [atl, dtw] }, 41.39, -83.63), ['ATL', 'DTW']);
    // Same callsign data, but the plane is over Miami: stale route.
    assert.deepEqual(adsb.parseRoute({ _airports: [atl, dtw] }, 25.8, -80.3), [null, null]);
    // Multi-leg: picks the leg the plane is on.
    assert.deepEqual(adsb.parseRoute({ _airports: [mia, atl, dtw] }, 41.39, -83.63), ['ATL', 'DTW']);
    assert.deepEqual(adsb.parseRoute({ _airports: [mia, atl, dtw] }, 29.5, -82.0), ['MIA', 'ATL']);
    // The old batch service's verdict is still honored when present.
    assert.deepEqual(adsb.parseRoute({ plausible: false, _airports: [atl, dtw] }, 41.39, -83.63), [null, null]);
    assert.deepEqual(adsb.parseRoute({ plausible: true, _airports: [atl, dtw] }, 25.8, -80.3), ['ATL', 'DTW']);
    assert.deepEqual(adsb.parseRoute({ _airports: [atl] }, 41.39, -83.63), [null, null]);
  });

  // ---- Phase 2: Wood County's traffic pattern ----
  const { WOOD_COUNTY } = await vite.ssrLoadModule('/src/airports/1g0.ts');
  const A = await vite.ssrLoadModule('/src/airports/airport.ts');
  const G = await vite.ssrLoadModule('/src/pattern/geometry.ts');
  const C = await vite.ssrLoadModule('/src/pattern/classify.ts');
  const O = await vite.ssrLoadModule('/src/pattern/overlay.ts');
  const close = (actual, expected, tolerance, what) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);
  const RWY_LAT = 41.3917; // 10/28 runs east-west along this latitude
  const [WEST_END, EAST_END] = [-83.63522, -83.61992]; // thresholds of 10 and 28
  const KM_LON = 0.01197; // one km of longitude here, in degrees
  const KM_LAT = 0.008983;
  /** A plane near Wood County at `altMsl` ft, sending both altitudes like a real one. */
  const near = (lat, lon, trackDeg, altMsl, over = {}) =>
    plane({ lat, lon, trackDeg, altitudeFt: altMsl, altitudeGeomFt: altMsl - 112, groundSpeedKt: 90, typeCode: 'P28A', ...over });

  test('runway and pattern geometry', () => {
    const r28 = A.runwayEnd(WOOD_COUNTY, '28');
    close(G.runwayLengthM(WOOD_COUNTY, r28), 1280, 10, '10/28 length (4,199 ft)');
    close(G.runwayLengthM(WOOD_COUNTY, A.runwayEnd(WOOD_COUNTY, '18')), 801, 10, '18/36 length (2,628 ft)');
    // Runway 28's far end is runway 10's threshold.
    const far = G.toRunwayFrame(A.runwayEnd(WOOD_COUNTY, '10').threshold, 271, r28);
    close(far.x, 1280, 10, 'far end x');
    close(far.y, 0, 25, 'far end y');
    assert.equal(far.relTrack, 0);

    // 10 left and 28 right both put the pattern north of the runway; 18 left and 36 right both east.
    for (const ident of ['10', '28']) {
      const downwind = G.buildPattern(WOOD_COUNTY, ident).legs.find((l) => l.leg === 'downwind');
      for (const pt of downwind.points) close(pt.lat - RWY_LAT, 0.75 * 1.852 * KM_LAT, 0.0005, `RWY ${ident} downwind is 0.75 nm north`);
    }
    for (const ident of ['18', '36']) {
      const downwind = G.buildPattern(WOOD_COUNTY, ident).legs.find((l) => l.leg === 'downwind');
      for (const pt of downwind.points) close(pt.lon - -83.63425, 0.75 * 1.852 * KM_LON, 0.0006, `RWY ${ident} downwind is 0.75 nm east`);
    }
    assert.deepEqual(G.LEGS.map((l) => G.legHeading(r28, l)), [271, 1, 91, 181, 271]);
    assert.deepEqual(G.LEGS.map((l) => G.legHeading(A.runwayEnd(WOOD_COUNTY, '10'), l)), [91, 1, 271, 181, 91]);

    const p28 = G.buildPattern(WOOD_COUNTY, '28');
    assert.deepEqual(p28.legs.map((l) => l.leg), G.LEGS);
    // Level at pattern altitude on crosswind and the first half of downwind, then down to the threshold.
    assert.equal(p28.legs[1].points[0].altFtMsl, 1700);
    assert.equal(p28.legs[2].points[1].altFtMsl, 1700);
    assert.equal(p28.legs[4].points[1].altFtMsl, 673 + 50);
    assert.equal(p28.legs[4].points[0].altFtMsl, 673 + 500);
    // Each leg starts where the one before ended.
    for (let i = 1; i < p28.legs.length; i++) assert.deepEqual(p28.legs[i].points[0], p28.legs[i - 1].points.at(-1));
    const dense = G.densify(p28.legs[2].points, 150);
    assert.ok(dense.length > 20 && dense.length < 40, `downwind sampled into ${dense.length} points`);
    assert.deepEqual(dense[0], p28.legs[2].points[0]);
    assert.deepEqual(dense.at(-1), p28.legs[2].points.at(-1));
  });

  // One hand-placed plane per leg, runway 28 in use (right traffic, pattern to the north).
  const onLeg = {
    final: near(41.39162, EAST_END + 1.5 * KM_LON, 271, 1100), // 1.5 km out on the centerline
    upwind: near(41.3918, WEST_END - 0.8 * KM_LON, 271, 1200), // just past the far end, climbing out
    crosswind: near(RWY_LAT + 0.7 * KM_LAT, WEST_END - 1.39 * KM_LON, 1, 1600), // heading north
    downwind: near(RWY_LAT + 1.39 * KM_LAT, -83.6276, 91, 1700), // abeam mid-field, heading east
    base: near(RWY_LAT + 0.7 * KM_LAT, EAST_END + 1.39 * KM_LON, 181, 1400), // heading south
    entry: near(RWY_LAT + 2.5 * KM_LAT, -83.6396, 136, 1700), // cutting in at 45 degrees from the north-west
    departure: near(41.3918, WEST_END - 4 * KM_LON, 271, 2000), // 4 km straight out
  };

  test('classifier: one plane per leg, runway 28', () => {
    for (const [leg, p] of Object.entries(onLeg)) {
      const r = C.classify(p, WOOD_COUNTY, '28');
      assert.equal(r.leg, leg, `expected ${leg}`);
      assert.ok(r.confidence >= C.MIN_CONFIDENCE, `${leg} confidence ${r.confidence}`);
    }
  });

  test('classifier: who is left out', () => {
    const dw = onLeg.downwind;
    const none = (p, why) => assert.equal(C.classify(p, WOOD_COUNTY, '28').leg, null, why);
    none({ ...dw, onGround: true }, 'on the ground');
    none({ ...dw, kind: 'helicopter' }, 'helicopter');
    none({ ...dw, groundSpeedKt: 12 }, 'too slow to be flying');
    none({ ...dw, trackDeg: null }, 'no track');
    none({ ...dw, altitudeFt: 3500, altitudeGeomFt: 3388 }, 'overflying well above the pattern');
    none({ ...dw, altitudeFt: null, altitudeGeomFt: null }, 'no altitude');
    none(near(RWY_LAT + 10 * KM_LAT, -83.6276, 91, 1700), '10 km away');
    none(near(RWY_LAT + 1.39 * KM_LAT, -83.6276, 1, 1700), 'on the downwind line but flying north across it');
    // Pressure altitude can be far off; the GPS altitude is what counts.
    assert.equal(C.classify({ ...dw, altitudeFt: 2600, altitudeGeomFt: 1588 }, WOOD_COUNTY, '28').leg, 'downwind');
    // No GPS altitude: fall back to pressure altitude.
    assert.equal(C.classify({ ...dw, altitudeGeomFt: null }, WOOD_COUNTY, '28').leg, 'downwind');
  });

  test('classifier: runway 10 mirrors it', () => {
    // Same spot north of the field, but now downwind is flown westbound (left traffic for 10).
    const westbound = near(RWY_LAT + 1.39 * KM_LAT, -83.6276, 271, 1700);
    assert.equal(C.classify(westbound, WOOD_COUNTY, '10').leg, 'downwind');
    assert.equal(C.classify(onLeg.downwind, WOOD_COUNTY, '10').leg, null); // eastbound up there fits nothing on 10
    // What was final for 28 is the departure end of 10: a plane there heading east is on upwind.
    assert.equal(C.classify(near(41.39162, EAST_END + 1.5 * KM_LON, 91, 1100), WOOD_COUNTY, '10').leg, 'upwind');
  });

  test('leg labels', () => {
    const [r28, r10] = [A.runwayEnd(WOOD_COUNTY, '28'), A.runwayEnd(WOOD_COUNTY, '10')];
    assert.equal(C.legLabel('downwind', r28), 'Right downwind · RWY 28');
    assert.equal(C.legLabel('base', r10), 'Left base · RWY 10');
    assert.equal(C.legLabel('final', r28), 'Final · RWY 28');
    assert.equal(C.legLabel('upwind', r28), 'Upwind · RWY 28');
    assert.equal(C.legLabel('entry', r28), 'Entering the pattern · RWY 28');
    assert.deepEqual(['upwind', 'crosswind', 'downwind', 'base', 'final', 'entry'].map(C.legCode), ['UW', 'XW', 'DW', 'B', 'F', null]);
  });

  test('tracker: a new leg has to win twice', () => {
    const t = C.createPatternTracker(WOOD_COUNTY);
    const as = (leg) => [{ ...onLeg[leg], id: 'bg1' }];
    t.update(as('downwind'), '28', 0);
    assert.equal(t.legOf('bg1').leg, 'downwind'); // first sighting counts straight away
    t.update(as('base'), '28', 500);
    assert.equal(t.legOf('bg1').leg, 'downwind'); // too soon: checks are 2 s apart
    t.update(as('base'), '28', 2000);
    assert.equal(t.legOf('bg1').leg, 'downwind'); // one reading isn't enough
    t.update(as('downwind'), '28', 4000);
    t.update(as('base'), '28', 6000);
    assert.equal(t.legOf('bg1').leg, 'downwind'); // the streak was broken, so it starts over
    t.update(as('base'), '28', 8000);
    assert.equal(t.legOf('bg1').leg, 'base'); // twice in a row
    // Leaving the pattern takes two checks as well.
    const gone = [{ ...onLeg.base, id: 'bg1', altitudeFt: 5000, altitudeGeomFt: 4888 }];
    t.update(gone, '28', 10000);
    assert.equal(t.legOf('bg1').leg, 'base');
    t.update(gone, '28', 12000);
    assert.equal(t.legOf('bg1'), null);
    // Changing the runway in use starts everyone from scratch.
    t.update(as('downwind'), '28', 14000);
    t.update(as('downwind'), '28', 16000);
    assert.equal(t.legOf('bg1').leg, 'downwind');
    t.update(as('downwind'), '10', 16500);
    assert.equal(t.legOf('bg1'), null); // an eastbound plane north of the field is on no leg for runway 10
    assert.equal(t.legOf('nobody'), null);
  });

  test('airport view from where you stand', () => {
    const view = O.createAirportView(WOOD_COUNTY);
    const atField = view(WOOD_COUNTY.position, '28');
    assert.equal(atField.patternRadarKm, 5);
    assert.equal(atField.overlay.runways.length, 2);
    assert.equal(atField.overlay.pattern.length, 7); // 6 corners, the abeam-threshold point on downwind
    assert.ok(atField.overlay.pattern.every((p) => p.distanceKm < 3.5), 'whole pattern within 3.5 km of the field');
    // Downwind in the sky: pattern altitude as an ellipsoid height (1,700 ft MSL = 518 m, minus 34 m).
    const top = Math.max(...atField.overlay.skyPattern.map((p) => p.altM));
    close(top, 484, 1, 'pattern altitude');
    assert.equal(view(WOOD_COUNTY.position, '28'), atField); // cached while you stand still
    assert.notEqual(view(WOOD_COUNTY.position, '10'), atField);
    const tolAirport = view({ lat: 41.587, lon: -83.808 }, '28'); // Toledo Express, about 26 km away
    assert.equal(tolAirport.patternRadarKm, null);
    close(tolAirport.distanceKm, 26.4, 1, 'distance from KTOL');
    assert.equal(view({ lat: 42.2, lon: -83.35 }, '28'), null); // Detroit: too far to show at all
  });

  // ---- A real landing: N442BG (BGSU Seminole), left pattern to runway 18, 2026-11-21 ----
  // Recorded from the app on the phone (docs/recordings/2026-11-21-n442bg-landing-rwy18.md):
  // seconds, distance km and bearing from the phone at 41.37987, -83.64328, pressure altitude ft.
  const R = await vite.ssrLoadModule('/src/pattern/runway.ts');
  const feed = await vite.ssrLoadModule('/src/flights/feed.ts');
  const LANDING = [[0,2.7,80,1375],[6,2.8,73,1376],[12,2.9,65,1375],[18,3.1,59,1408],[24,3.3,54,1392],[30,3.6,48,1318],[36,3.9,44,1240],[42,4.1,41,1246],[48,4.4,38,1194],[54,4.6,35,1174],[60,4.7,31,1113],[66,4.7,27,1053],[72,4.7,23,988],[78,4.5,20,993],[84,4.4,17,971],[90,4.3,14,948],[96,4.1,12,915],[102,3.9,11,855],[108,3.7,11,820],[114,3.5,12,755],[120,3.2,13,672],[126,3.0,14,657],[132,2.8,15,612],[138,2.6,17,567],[144,2.4,19,522],[150,2.2,20,444]];
  const PHONE = { lat: 41.3798685, lon: -83.6432775 };
  const fixes = LANDING.map(([t, d, b, alt]) => {
    const r = (b * Math.PI) / 180;
    return { t, alt, lat: PHONE.lat + (d * Math.cos(r)) / 111.32, lon: PHONE.lon + (d * Math.sin(r)) / (111.32 * Math.cos((PHONE.lat * Math.PI) / 180)) };
  });
  // Track and speed from one fix to the next, as the plane would have reported them.
  const landing = fixes.map((f, i) => {
    const [a, b] = [fixes[Math.max(0, i - 1)], fixes[Math.min(fixes.length - 1, i + 1)]];
    const [dn, de] = [(b.lat - a.lat) * 111.32, (b.lon - a.lon) * 111.32 * Math.cos((f.lat * Math.PI) / 180)];
    return plane({
      id: 'a5b1c2', callsign: 'N442BG', registration: 'N442BG', typeCode: 'PA44', lat: f.lat, lon: f.lon,
      trackDeg: ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360,
      groundSpeedKt: Math.hypot(dn, de) / ((b.t - a.t) / 3600) / 1.852,
      altitudeFt: f.alt, altitudeGeomFt: null, // pressure altitude only, about 310 ft low that night
    });
  });
  /** The legs a tracker shows over the recording, without repeats. */
  const legsShown = (runwayFor) => {
    const tracker = C.createPatternTracker(WOOD_COUNTY);
    const shown = [];
    landing.forEach((p, i) => {
      tracker.update([p], runwayFor(p, i), LANDING[i][0] * 1000);
      const leg = tracker.legOf(p.id)?.leg ?? null;
      if (leg !== shown.at(-1)) shown.push(leg);
    });
    return shown;
  };

  test('real landing: with runway 18 it reads downwind, base, final', () => {
    assert.deepEqual(legsShown(() => '18'), ['downwind', 'base', 'final']);
  });

  test('real landing: the wide turn to base is not a pattern entry', () => {
    // 54 s and 60 s in: turning west, 2.5 km past the threshold. Used to come out as "entry".
    for (const i of [9, 10]) assert.notEqual(C.classify(landing[i], WOOD_COUNTY, '18').leg, 'entry', `fix ${i}`);
    // The 45-degree entry abeam the runway still is one.
    assert.equal(C.classify(onLeg.entry, WOOD_COUNTY, '28').leg, 'entry');
  });

  test('real landing: the runway in use is worked out from the plane itself', () => {
    const detector = R.createRunwayDetector(WOOD_COUNTY);
    const seen = landing.map((p, i) => detector.update([p], LANDING[i][0] * 1000));
    assert.equal(seen[0], null); // one look is not enough
    // Runway 18 from the downwind leg alone, within the first 20 seconds...
    const firstAt = LANDING[seen.findIndex((s) => s)][0];
    assert.ok(firstAt <= 20, `first detection at ${firstAt} s`);
    assert.ok(seen.filter(Boolean).every((s) => s.ident === '18'), `only ever 18, got ${[...new Set(seen.filter(Boolean).map((s) => s.ident))]}`);
    assert.equal(seen.find((s) => s).strong, false);
    // ...and confirmed once it is on final.
    assert.deepEqual({ ident: seen.at(-1).ident, by: seen.at(-1).by, strong: seen.at(-1).strong }, { ident: '18', by: 'N442BG', strong: true });
    // So in Auto the whole pattern is labeled right, starting from the default of 28.
    const auto = R.createRunwayDetector(WOOD_COUNTY);
    assert.deepEqual(legsShown((p, i) => auto.update([p], LANDING[i][0] * 1000)?.ident ?? WOOD_COUNTY.defaultRunway).filter(Boolean), ['downwind', 'base', 'final']);
  });

  test('runway detector: a landing outranks a plane passing by on a downwind line', () => {
    const detector = R.createRunwayDetector(WOOD_COUNTY);
    const at = (planes, s) => detector.update(planes, s * 1000);
    for (let s = 0; s <= 4; s += 2) at([{ ...onLeg.final, id: 'lander' }], s); // on final for 28
    assert.deepEqual([detector.current().ident, detector.current().strong], ['28', true]);
    // Minutes later something flies north past the east side at pattern altitude: 18's downwind line.
    for (let s = 300; s <= 320; s += 2) at([{ ...landing[2], id: 'passer' }], s);
    assert.equal(detector.current().ident, '28');
    // But an actual landing on 18 changes it.
    for (let s = 400; s <= 404; s += 2) at([{ ...landing[22], id: 'lander2' }], s);
    assert.deepEqual([detector.current().ident, detector.current().strong], ['18', true]);
    // Nothing around: it stays as it was.
    at([], 500);
    assert.equal(detector.current().ident, '18');
  });

  test('positions are not flown on from stale data', () => {
    // 120 kt due north = 61.7 m per second.
    const p = plane({ lat: 41.4, lon: -83.6, trackDeg: 0, groundSpeedKt: 120, altitudeFt: 1000, altitudeGeomFt: 1100, verticalRateFpm: -600 });
    const viewer = { lat: 41.4, lon: -83.6 };
    const movedM = (ageAtFetchS, sinceFetchS) => {
      const [out] = feed.extrapolate([{ ...p, positionAgeS: ageAtFetchS }], 0, sinceFetchS * 1000, viewer);
      return { m: Math.round((out.lat - p.lat) * 111_320), alt: Math.round(out.altitudeFt) };
    };
    close(movedM(0, 10).m, 617, 2, 'fresh position, 10 s after the fetch');
    close(movedM(5, 10).m, 926, 2, 'already 5 s old when fetched: 15 s of flying');
    close(movedM(null, 10).m, 617, 2, 'older data without the field');
    // Lost from coverage: every poll returns the same position, older each time. It stops after a minute's worth.
    close(movedM(45, 5).m, 3087, 2, '50 s of flying');
    close(movedM(58, 5).m, 3704, 2, 'capped at 60 s');
    close(movedM(300, 5).m, 3704, 2, 'long gone: still 60 s worth');
    // Altitude is carried forward for 20 s at most: -600 fpm is 200 ft, however stale the position.
    assert.equal(movedM(0, 10).alt, 900);
    assert.equal(movedM(300, 5).alt, 800);
  });

  // ---- Phase 6: the runway the wind favors ----
  const WIND = await vite.ssrLoadModule('/src/pattern/wind.ts');
  test('runway from the wind', () => {
    const pick = (dirDeg, speedKt) => WIND.runwayForWind(WOOD_COUNTY, { dirDeg, speedKt })?.ident ?? null;
    assert.equal(pick(190, 8), '18'); // from the south: land to the south
    assert.equal(pick(350, 12), '36');
    assert.equal(pick(270, 10), '28');
    assert.equal(pick(100, 6), '10');
    assert.equal(pick(230, 10), '28'); // between 18 and 28: 40 degrees off 28, 51 off 18
    assert.equal(pick(220, 10), '18');
    assert.equal(pick(190, 3), null); // too light to decide
    assert.equal(pick(null, 9), null); // variable
    const r = WIND.runwayForWind(WOOD_COUNTY, { dirDeg: 209, speedKt: 10 });
    assert.equal(r.ident, '18');
    close(r.headwindKt, 8.7, 0.1, 'headwind');
    close(r.crosswindKt, 5, 0.1, 'crosswind');
    assert.equal(WIND.windWords({ dirDeg: 194, speedKt: 8, gustKt: null }), '190 at 8');
    assert.equal(WIND.windWords({ dirDeg: 4, speedKt: 12, gustKt: 19 }), '360 at 12 gusting 19');
    assert.equal(WIND.windWords({ dirDeg: null, speedKt: 3, gustKt: null }), 'variable at 3');
    assert.equal(WIND.windWords({ dirDeg: 0, speedKt: 0, gustKt: null }), 'calm');
  });

  // ---- Phase 6: a filter on the sky ----
  const SKY = await vite.ssrLoadModule('/src/sky-filter.ts');
  test('sky filter: what it keeps, and what it is called', () => {
    const sky = [
      plane({ id: 'h1', kind: 'helicopter', typeCode: 'EC35' }),
      plane({ id: 'j1', typeCode: 'B738', callsign: 'SWA407', altitudeFt: 36000 }),
      plane({ id: 'j2', typeCode: 'A320', callsign: 'DAL18', altitudeFt: 9000 }),
      plane({ id: 'g1', typeCode: 'P28A', registration: 'N337BG', onGround: true, altitudeFt: null }),
    ];
    const ids = (f) => SKY.applySkyFilter(sky, SKY.skyFilterFrom(f)).map((p) => p.id);
    assert.deepEqual(ids({ kind: 'helicopters' }), ['h1']);
    assert.deepEqual(ids({ airline: 'SWA', minAltFt: 30000 }), ['j1']);
    // No filter, or nothing valid in it: everything stays, ground traffic included.
    assert.deepEqual(ids(null), ['h1', 'j1', 'j2', 'g1']);
    assert.deepEqual(ids({ nonsense: true }), ['h1', 'j1', 'j2', 'g1']);
    assert.equal(SKY.skyFilterFrom({ sort: 'altitude', page: 2 }), null); // sorting and paging mean nothing in the sky
    // The sky never hid planes on the ground, so a filter doesn't start to (the list does by default).
    assert.deepEqual(ids({ kind: 'props' }), ['g1']);
    assert.deepEqual(ids({ kind: 'props', onGround: 'hide' }), []);
    assert.equal(SKY.skyFilterLabel(SKY.skyFilterFrom({ kind: 'helicopters' })), 'helicopters');
    assert.equal(SKY.skyFilterLabel(SKY.skyFilterFrom({ fleet: 'bgsu', maxAltFt: 3000 })), 'BGSU, <3,000 ft');
  });

  // ---- Phase 5: who is a plane talking to, and the controllers on the compass bar ----
  const W = await vite.ssrLoadModule('/src/atc/whoControls.ts');
  const ATC = await vite.ssrLoadModule('/src/atc/facilities.ts');
  const ST = await vite.ssrLoadModule('/src/atc/stations.ts');
  test('who controls: Wood County, Toledo by sector, Detroit, Cleveland Center, nobody', () => {
    const who = (over) => {
      const g = W.whoControls(plane(over));
      return g ? `${g.facility.id} ${g.freq ?? '-'}` : null;
    };
    // In the pattern at 1G0, and on its ramp.
    assert.equal(who({ lat: 41.4, lon: -83.63, altitudeFt: 1700 }), '1g0-ctaf 122.975');
    assert.equal(who({ lat: 41.391, lon: -83.63, altitudeFt: null, onGround: true }), '1g0-ctaf 122.975');
    // Over the field but high: Toledo Approach, and Bowling Green is southeast of Toledo (126.1).
    assert.equal(who({ lat: 41.4, lon: -83.63, altitudeFt: 4500 }), 'tol-app 126.1');
    // West of Toledo: the other sector.
    assert.equal(who({ lat: 41.6, lon: -84.3, altitudeFt: 5000 }), 'tol-app 134.35');
    // Near Detroit Metro, low: Detroit, sector not guessed.
    assert.equal(who({ lat: 42.2, lon: -83.3, altitudeFt: 6000 }), 'dtw-app -');
    // Between Toledo and Detroit: whichever airport is nearer.
    assert.equal(who({ lat: 41.75, lon: -83.7, altitudeFt: 7000 }), 'tol-app 126.1');
    assert.equal(who({ lat: 42.0, lon: -83.45, altitudeFt: 7000 }), 'dtw-app -');
    // An airliner at cruise over northwest Ohio: Cleveland Center's Bluffton sector.
    assert.equal(who({ lat: 41.1, lon: -83.7, altitudeFt: 36000 }), 'zob 119.325');
    // Cleveland Center elsewhere (over Lake Erie; or mid-level near home): no frequency claimed.
    assert.equal(who({ lat: 41.9, lon: -81.5, altitudeFt: 34000 }), 'zob -');
    assert.equal(who({ lat: 41.4, lon: -83.63, altitudeFt: 15000 }), 'zob -');
    // Chicago, 200 miles west: not ours.
    assert.equal(who({ lat: 41.98, lon: -87.9, altitudeFt: 3000 }), null);
    // Unknown altitude in the air near home: not assumed to be in the pattern.
    assert.equal(who({ lat: 41.4, lon: -83.63, altitudeFt: null, altitudeGeomFt: null }), 'zob -');
  });

  test('the radio line on a plane card', () => {
    const toledo = { facility: ATC.TOLEDO_APPROACH, freq: '126.1' };
    assert.equal(W.radioLine(toledo, null), '📻 Likely Toledo Approach 126.1');
    assert.equal(W.radioLine(toledo, { facility: ATC.TOLEDO_APPROACH, agoS: 40 }), '📻 Toledo Approach 126.1 · ✅ heard 40s ago');
    // Heard somewhere other than the guess: what was heard wins, with that feed's one frequency.
    assert.equal(W.radioLine(toledo, { facility: ATC.CLEVELAND_CENTER, agoS: 200 }), '📻 Cleveland Center 119.325 · ✅ heard 3 min ago');
    // Heard on Toledo with no guess: two frequencies, so none is claimed.
    assert.equal(W.radioLine(null, { facility: ATC.TOLEDO_APPROACH, agoS: 5 }), '📻 Toledo Approach · ✅ heard 5s ago');
    // A controller with several channels: the one it was heard on is named.
    assert.equal(W.radioLine({ facility: ATC.DETROIT_APPROACH, freq: null }, { facility: ATC.DETROIT_APPROACH, agoS: 12, channel: 'Arrival East' }), '📻 Detroit Metro (Arrival East) · ✅ heard 12s ago');
    assert.equal(W.radioLine({ facility: ATC.DETROIT_APPROACH, freq: null }, null), '📻 Likely Detroit Metro');
    assert.equal(W.radioLine({ facility: ATC.DETROIT_APPROACH, freq: null }, null, false), '📻 Likely Detroit Metro · no live feed');
    assert.equal(W.radioLine(null, null), null);
  });

  // The Mac's feed list, as the phone sees it: several feeds can belong to one controller.
  const FEEDS = [
    { id: '1g0-ctaf', facility: '1g0-ctaf', channel: 'CTAF', tag: 'CTAF', freqs: ['122.975'], status: 'idle' },
    { id: 'tol-app', facility: 'tol-app', channel: 'Tower and Approach', tag: 'TOL', freqs: ['118.1', '126.1', '134.35'], status: 'online' },
    { id: 'dtw-app-west', facility: 'dtw-app', channel: 'Arrival West', tag: 'ARR W', freqs: ['124.05'], status: 'online' },
    { id: 'dtw-app-east', facility: 'dtw-app', channel: 'Arrival East', tag: 'ARR E', freqs: ['125.15'], status: 'online' },
    { id: 'dtw-dep-east', facility: 'dtw-app', channel: 'Departure East', tag: 'DEP E', freqs: ['132.025'], status: 'idle' },
    { id: 'dtw-twr', facility: 'dtw-app', channel: 'Tower', tag: 'TWR', freqs: ['118.4', '135.0'], status: 'offline' },
    { id: 'zob-47', facility: 'zob', channel: 'Bluffton High', tag: 'BLUFFTON', freqs: ['119.325'], status: 'connecting' },
  ];

  test('feeds are grouped under their controller', () => {
    assert.deepEqual(ATC.channelsOf(ATC.DETROIT_APPROACH, FEEDS).map((f) => f.id), ['dtw-app-west', 'dtw-app-east', 'dtw-dep-east', 'dtw-twr']);
    assert.deepEqual(ATC.channelsOf(ATC.TOLEDO_APPROACH, FEEDS).map((f) => f.id), ['tol-app']);
    assert.deepEqual(ATC.channelsOf(ATC.COLUMBUS_APPROACH, FEEDS), []); // none on the Mac
    // A feed list from an older server (no grouping): the controller's own feed id still finds it.
    assert.deepEqual(ATC.channelsOf(ATC.CLEVELAND_CENTER, [{ id: 'zob-47', facility: 'zob-47' }]).map((f) => f.id), ['zob-47']);
    assert.equal(ATC.facilityOfFeed(FEEDS[5]).id, 'dtw-app');
    assert.equal(ATC.facilityOfFeed({ id: 'zob-47', facility: 'zob-47' }).id, 'zob');
    assert.equal(ATC.facilityOfFeed({ id: 'nope', facility: 'nope' }), null);
    assert.equal(ATC.facilityOfFeed(null), null);
  });

  test('controllers on the compass bar', () => {
    const stations = ST.createStations();
    const info = (f, listeningTo = null) => ({
      channels: ATC.channelsOf(f, FEEDS).map((c) => ({
        feedId: c.id, label: c.channel, freqs: c.freqs, status: c.status,
        lastCall: c.id === 'tol-app' ? { text: 'Delta 1830, descend and maintain 4,000.', agoS: 40 } : c.id === 'dtw-app-east' ? { text: 'Spirit 211, turn left heading 180.', agoS: 15 } : null,
      })),
      listeningTo,
    });
    // Standing 1 km south of the Wood County reference point.
    const built = stations.build({ lat: 41.382, lon: -83.6301389 }, (f) => info(f));
    const by = Object.fromEntries(built.map((s) => [s.id, s]));
    close(by['1g0-ctaf'].bearingDeg, 0, 1, 'the field is due north');
    close(by['tol-app'].bearingDeg, 327, 2, 'Toledo Express is northwest');
    close(by['dtw-app'].bearingDeg, 14, 2, 'Detroit Metro is north-northeast');
    close(by.zob.bearingDeg, 94, 2, 'Oberlin is east');
    close(by['cmh-app'].bearingDeg, 158, 2, 'Columbus is south-southeast');
    assert.equal(built.length, 5); // one icon per controller, however many channels it has
    assert.equal(by['tol-app'].color, ST.FEED_COLORS.online);
    assert.equal(by['dtw-app'].color, ST.FEED_COLORS.online); // any channel live
    assert.equal(by.zob.color, ST.FEED_COLORS.connecting);
    assert.equal(by['1g0-ctaf'].color, ST.FEED_COLORS.none); // never captured: nothing to hear
    assert.equal(by['cmh-app'].color, ST.FEED_COLORS.none); // no feed at all
    assert.deepEqual(by['tol-app'].card, ['Toledo Approach', '118.1 · 126.1 · 134.35 · 27 km', 'Live', '“Delta 1830, descend and maintain 4,000.” 40s ago', 'Say “Can I access?”']);
    assert.deepEqual(by['1g0-ctaf'].card, ['Wood County CTAF', '122.975 · 1.0 km', 'Not playing on the Mac']);
    assert.deepEqual(by['cmh-app'].card.slice(1), ['125.95 · 166 km', 'No live feed']);
    assert.equal(by['1g0-ctaf'].tag, 'COMMON FREQUENCY');
    // Detroit: its channels on the card, live ones first.
    assert.deepEqual(by['dtw-app'].card, [
      'Detroit Metro', '95 km · 2 of 4 channels live',
      '● Arrival West 124.05', '● Arrival East 125.15', '○ Departure East 132.025', '○ Tower 118.4 / 135.0',
      '“Spirit 211, turn left heading 180.” 15s ago · Arrival East', 'Say “Can I access?”',
    ]);
    // Listening to one of them.
    const listening = stations.build({ lat: 41.382, lon: -83.63 }, (f) => info(f, 'dtw-app-east')).find((s) => s.id === 'dtw-app');
    assert.equal(listening.card[3], '▶ Arrival East 125.15');
    assert.equal(listening.card.at(-1), 'Say “switch to Arrival West” or “Disconnect”');
    const toledo = stations.build({ lat: 41.382, lon: -83.63 }, (f) => info(f, 'tol-app')).find((s) => s.id === 'tol-app');
    assert.deepEqual(toledo.card.slice(2), ['Live · you are listening', '“Delta 1830, descend and maintain 4,000.” 40s ago', 'Say “Disconnect” to stop']);
    // Standing on the field: its bearing stays where it last made sense instead of spinning.
    const onTop = stations.build({ lat: 41.3911, lon: -83.6301389 }, (f) => info(f)).find((s) => s.id === '1g0-ctaf');
    close(((onTop.bearingDeg + 180) % 360) - 180, 0, 1, 'kept (about north, as it was a kilometer away)');
  });

  // ---- Phase 4: which plane is a radio call about? ----
  const M = await vite.ssrLoadModule('/src/radio/match.ts');
  test('radio calls are matched to planes', () => {
    const sky = [
      plane({ id: 'r1', callsign: 'DAL1830', registration: 'N301DN', distanceKm: 62 }),
      plane({ id: 'r2', callsign: 'DAL183', registration: 'N302DN', distanceKm: 20 }),
      plane({ id: 'r3', callsign: 'N901BG', registration: 'N901BG', distanceKm: 3 }),
      plane({ id: 'r4', callsign: 'N491BG', registration: 'N491BG', distanceKm: 9 }),
      plane({ id: 'r5', callsign: null, registration: 'N337BG', distanceKm: 30 }),
      plane({ id: 'r6', callsign: 'SWA407', registration: 'N8501V', distanceKm: 140 }),
    ];
    const who = (...tokens) => M.matchCall(tokens, sky)?.id ?? null;
    assert.equal(who('DAL1830'), 'r1'); // exact, even though DAL183 is closer
    assert.equal(who('DAL18'), null); // part of a flight number is not a match
    assert.equal(who('N901BG'), 'r3');
    assert.equal(who('901BG'), 'r3'); // "Archer 901 Bravo Golf"
    assert.equal(who('1BG'), 'r3'); // "one Bravo Golf": both N901BG and N491BG end that way, the closer one wins
    assert.equal(who('91BG'), 'r4');
    assert.equal(who('337BG'), 'r5'); // registration only, no callsign transmitted
    assert.equal(who('BG'), null); // too short to mean anything
    assert.equal(who('N8501V'), 'r6'); // an airliner by its tail number
    assert.equal(who('UAL999'), null);
    assert.equal(who('UAL999', 'SWA407'), 'r6'); // the first callsign that matches something
    assert.equal(who(), null);
    assert.equal(M.matchToken('', sky), null);
  });

  const dataArg = process.argv.indexOf('--data');
  if (dataArg > 0) {
    const raw = JSON.parse(readFileSync(process.argv[dataArg + 1], 'utf-8'));
    const planes = nearby.buildPlanes(raw.ac, 41.391, -83.6301, 463);
    const tally = {};
    for (const p of planes) {
      const k = p.onGround ? 'on ground' : p.kind === 'helicopter' ? 'helicopter' : (engineKind(p) ?? 'unclassified');
      tally[k] = (tally[k] ?? 0) + 1;
    }
    console.log(`${planes.length} planes:`, tally);
    const odd = planes.filter((p) => !p.onGround && p.kind !== 'helicopter' && !engineKind(p)).slice(0, 12);
    for (const p of odd) console.log(`  unclassified: ${p.callsign ?? p.id} type=${p.typeCode} cat=${p.category} alt=${p.altitudeFt} gs=${p.groundSpeedKt}`);
  }
  // ---- Where a plane left from: small planes file no flight plan, so it is worked out by watching ----
  const AF = await vite.ssrLoadModule('/src/airports/lookup.ts');
  const DEP = await vite.ssrLoadModule('/src/departures/departures.ts');
  test('airfields: which one a point is at', () => {
    assert.equal(AF.nearestAirfield(41.392, -83.632)?.code, '1G0');
    assert.equal(AF.nearestAirfield(41.0135, -83.6687)?.code, 'FDY');
    assert.equal(AF.nearestAirfield(41.2, -83.2, { maxNm: 1 }), null, 'open country');
    // Nietz (private, 2.4 nm from Wood County): right on it, it is Nietz; a mile off, the public airport.
    const nietz = AF.nearestAirfield(41.391, -83.6301, { maxNm: 5 });
    assert.equal(nietz.code, '1G0');
    // The hospital pad two miles from the airport is a place only a helicopter leaves from.
    const pad = [41.3742, -83.6665];
    const forPlane = AF.nearestAirfield(pad[0], pad[1], { maxNm: 3 });
    const forHeli = AF.nearestAirfield(pad[0], pad[1], { maxNm: 3, helicopter: true });
    assert.notEqual(forPlane?.kind, 'H');
    assert.equal(forHeli?.kind, 'H');
    assert.equal(AF.nearestAirfield(pad[0], pad[1], { maxNm: 3, helicopter: true, publicOnly: true })?.kind, 'S');
  });
  test('airfields: names short enough for a card', () => {
    const short = (name, city = 'Town', code = 'XXX', kind = 'S') => AF.shortName({ name, city, code, kind });
    assert.equal(short('Wood County Airport'), 'Wood County');
    assert.equal(short('Findlay Airport'), 'Findlay');
    assert.equal(short('Toledo Executive Airport'), 'Toledo Executive');
    assert.equal(short('Windsor International Airport'), 'Windsor');
    assert.equal(short('Deshler Municipal Landing Strip'), 'Deshler');
    assert.equal(short('Aring Field'), 'Aring Field');
    assert.equal(short('Eugene F. Kranz Toledo Express Airport', 'Toledo', 'TOL', 'M'), 'Toledo (TOL)');
    assert.equal(short('Detroit Metropolitan Wayne County Airport', 'Detroit', 'DTW', 'L'), 'Detroit (DTW)');
    assert.equal(short('Wood County Hospital Heliport', 'Bowling Green', '85OH', 'H'), 'Wood County Hospital');
    assert.equal(short('Mercy Health St Charles Hospital Heliport', 'Oregon', 'OI44', 'H'), 'Mercy Health St Charles…');
  });
  // A Skyhawk with no altitude from GPS (so the barometric one is used), at Wood County unless told otherwise.
  const skyhawk = (over = {}) => plane({ id: 'a1b2c3', callsign: 'N529BG', lat: 41.391, lon: -83.6301, altitudeFt: 673, altitudeGeomFt: null, groundSpeedKt: 0, trackDeg: 280, ...over });
  const T = 1_800_000_000_000;
  const MIN = 60_000;
  test('departures: stopped on a field, then gone: it is from there', () => {
    const d = DEP.createDepartures();
    d.update([skyhawk({ onGround: true })], T);
    assert.equal(d.line('a1b2c3', T), null, 'still there');
    assert.equal(d.at('a1b2c3')?.code, '1G0');
    d.update([skyhawk({ lat: 41.395, lon: -83.66, altitudeFt: 1500, groundSpeedKt: 80, verticalRateFpm: 700 })], T + MIN);
    assert.equal(d.line('a1b2c3', T + MIN), 'From Wood County · just now');
    d.update([skyhawk({ lat: 41.2, lon: -84.0, altitudeFt: 3500, groundSpeedKt: 105 })], T + 25 * MIN);
    assert.equal(d.line('a1b2c3', T + 25 * MIN), 'From Wood County · 25 min ago');
    assert.equal(d.line('a1b2c3', T + 100 * MIN), 'From Wood County · 1 h 40 min ago');
    assert.deepEqual(d.brief('a1b2c3', T + 25 * MIN), { code: '1G0', name: 'Wood County Airport', city: 'Bowling Green', kind: 'S', lat: 41.391, lon: -83.6301, agoMin: 25, how: 'from' });
    assert.equal(d.line('a1b2c3', T + 9 * 60 * MIN), null, 'too long ago to mean anything');
    assert.deepEqual(d.known(T + 25 * MIN), [{ id: 'a1b2c3', line: 'From Wood County · 25 min ago', source: 'seen' }]);
  });
  test('departures: a full stop somewhere else makes that the new start', () => {
    const d = DEP.createDepartures();
    d.update([skyhawk({ onGround: true })], T);
    d.update([skyhawk({ lat: 41.2, lon: -83.65, altitudeFt: 3000, groundSpeedKt: 100 })], T + 8 * MIN);
    assert.match(d.line('a1b2c3', T + 8 * MIN), /^From Wood County/);
    // Lands at Findlay and taxis in: it is there now, not "from" anywhere.
    d.update([skyhawk({ lat: 41.0135, lon: -83.6687, altitudeFt: 813, onGround: true, groundSpeedKt: 12 })], T + 20 * MIN);
    assert.equal(d.line('a1b2c3', T + 20 * MIN), null);
    assert.equal(d.at('a1b2c3')?.code, 'FDY');
    d.update([skyhawk({ lat: 41.1, lon: -83.67, altitudeFt: 2500, groundSpeedKt: 95, verticalRateFpm: 500 })], T + 30 * MIN);
    assert.match(d.line('a1b2c3', T + 30 * MIN), /^From Findlay · /);
    // Parked with the transponder off (no fresh position for a while), then seen flying: a stop all the same.
    const e = DEP.createDepartures();
    e.update([skyhawk({ lat: 41.0135, lon: -83.6687, altitudeFt: 900, groundSpeedKt: 65, verticalRateFpm: -400 })], T);
    e.update([skyhawk({ lat: 41.03, lon: -83.6687, altitudeFt: 1600, groundSpeedKt: 80, verticalRateFpm: 600 })], T + 20 * MIN);
    assert.equal(e.line('a1b2c3', T + 20 * MIN), 'From Findlay · just now');
  });
  test('departures: a touch-and-go is "seen leaving", and never replaces where it is from', () => {
    // Origin unknown: low over Findlay at flying speed, then climbing away a minute later.
    const d = DEP.createDepartures();
    d.update([skyhawk({ lat: 41.0135, lon: -83.66, altitudeFt: 1000, groundSpeedKt: 70, verticalRateFpm: -400 })], T);
    d.update([skyhawk({ lat: 41.0135, lon: -83.6687, altitudeFt: 813, groundSpeedKt: 55, onGround: true })], T + 0.5 * MIN);
    d.update([skyhawk({ lat: 41.0135, lon: -83.72, altitudeFt: 1700, groundSpeedKt: 80, verticalRateFpm: 600 })], T + 2 * MIN);
    assert.equal(d.line('a1b2c3', T + 2 * MIN), 'Seen leaving Findlay · 2 min ago');
    assert.equal(d.brief('a1b2c3', T + 2 * MIN).how, 'leaving');
    // The same bounce by a plane known to be from Wood County: still from Wood County.
    const e = DEP.createDepartures();
    e.update([skyhawk({ onGround: true })], T - 30 * MIN);
    e.update([skyhawk({ lat: 41.2, lon: -83.65, altitudeFt: 3000, groundSpeedKt: 100 })], T - 20 * MIN);
    e.update([skyhawk({ lat: 41.0135, lon: -83.66, altitudeFt: 1000, groundSpeedKt: 70, verticalRateFpm: -400 })], T);
    assert.match(e.line('a1b2c3', T), /^From Wood County/, 'low over the field it is passing');
    e.update([skyhawk({ lat: 41.0135, lon: -83.72, altitudeFt: 1700, groundSpeedKt: 80, verticalRateFpm: 600 })], T + 2 * MIN);
    assert.equal(e.line('a1b2c3', T + 2 * MIN), 'From Wood County · 29 min ago');
  });
  test('departures: a landing carried past the runway between reports is not a takeoff', () => {
    const d = DEP.createDepartures();
    // Low on final, never stopped, then (dead-reckoned) beyond the field, still descending.
    d.update([skyhawk({ lat: 41.391, lon: -83.615, altitudeFt: 900, groundSpeedKt: 70, verticalRateFpm: -500 })], T);
    assert.equal(d.at('a1b2c3')?.code, '1G0');
    d.update([skyhawk({ lat: 41.391, lon: -83.68, altitudeFt: 700, groundSpeedKt: 70, verticalRateFpm: -500 })], T + MIN);
    assert.equal(d.line('a1b2c3', T + MIN), null);
    // Rolling out with "on ground" set, drifted off the list's reach: still not a departure.
    const e = DEP.createDepartures();
    e.update([skyhawk({ onGround: true })], T);
    e.update([skyhawk({ onGround: true, lat: 41.391, lon: -83.70 })], T + MIN);
    assert.equal(e.line('a1b2c3', T + MIN), null);
    assert.equal(e.at('a1b2c3')?.code, '1G0');
  });
  test('departures: first seen climbing away is "seen leaving", passing by is nothing', () => {
    const d = DEP.createDepartures();
    // 3 nm north of Findlay at 1,500 ft above it, climbing, heading north (away).
    d.update([skyhawk({ lat: 41.0635, lon: -83.6687, altitudeFt: 2300, groundSpeedKt: 90, trackDeg: 0, verticalRateFpm: 600 })], T);
    assert.equal(d.line('a1b2c3', T), 'Seen leaving Findlay · 2 min ago');
    for (const [name, over] of [
      ['level', { verticalRateFpm: 0 }],
      ['climbing toward the field', { trackDeg: 180 }],
      ['high', { altitudeFt: 6000 }],
      ['far', { lat: 41.2, trackDeg: 0 }],
    ]) {
      const e = DEP.createDepartures();
      e.update([skyhawk({ lat: 41.0635, lon: -83.6687, altitudeFt: 2300, groundSpeedKt: 90, trackDeg: 0, verticalRateFpm: 600, ...over })], T);
      assert.equal(e.line('a1b2c3', T), null, name);
    }
    // Not the first sighting: a plane the app has been following doesn't "leave" a field it flies past.
    const f = DEP.createDepartures();
    f.update([skyhawk({ lat: 40.8, lon: -83.6687, altitudeFt: 2300, groundSpeedKt: 90, trackDeg: 0 })], T);
    f.update([skyhawk({ lat: 41.0635, lon: -83.6687, altitudeFt: 2300, groundSpeedKt: 90, trackDeg: 0, verticalRateFpm: 600 })], T + 10 * MIN);
    assert.equal(f.line('a1b2c3', T + 10 * MIN), null);
  });
  test('departures: GPS altitude, stale positions, and what the Mac found', () => {
    const d = DEP.createDepartures({ geoidSeparationM: -34 });
    // GPS altitude is above the ellipsoid, 112 ft below sea-level height here: 1,100 ft GPS over a
    // 673 ft field is 539 ft above it (at the field), though the barometric reading says 2,000.
    d.update([skyhawk({ altitudeGeomFt: 1100, altitudeFt: 2000, groundSpeedKt: 70 })], T);
    assert.equal(d.at('a1b2c3')?.code, '1G0');
    // A position that old says nothing.
    const e = DEP.createDepartures();
    e.update([skyhawk({ onGround: true, positionAgeS: 400 })], T);
    assert.equal(e.at('a1b2c3'), null);
    // From the Mac (the start of OpenSky's track): fills a gap...
    const delaware = { field: { code: 'DLZ', name: 'Delaware Municipal Airport', city: 'Delaware', kind: 'S', lat: 40.2797, lon: -83.1148 }, atMs: T - 40 * MIN, how: 'from', source: 'opensky' };
    e.set('ffffff', delaware, T);
    assert.equal(e.line('ffffff', T), 'From Delaware · 40 min ago');
    e.set('eeeeee', { ...delaware, how: 'near' }, T);
    assert.equal(e.line('eeeeee', T), 'From near Delaware · 40 min ago');
    // ...replaces "seen leaving" (the real case: a plane from Delaware first seen climbing out of Marion),
    // and a later bounce doesn't undo it...
    const m = DEP.createDepartures();
    m.update([skyhawk({ lat: 41.0635, lon: -83.6687, altitudeFt: 2300, groundSpeedKt: 90, trackDeg: 0, verticalRateFpm: 600 })], T);
    assert.match(m.line('a1b2c3', T), /^Seen leaving Findlay/);
    m.set('a1b2c3', delaware, T);
    assert.equal(m.line('a1b2c3', T), 'From Delaware · 40 min ago');
    m.update([skyhawk({ lat: 41.391, lon: -83.62, altitudeFt: 900, groundSpeedKt: 70, verticalRateFpm: -400 })], T + 10 * MIN);
    m.update([skyhawk({ lat: 41.392, lon: -83.67, altitudeFt: 1500, groundSpeedKt: 80, verticalRateFpm: 600 })], T + 11 * MIN);
    assert.equal(m.line('a1b2c3', T + 11 * MIN), 'From Delaware · 51 min ago');
    // ...but never replaces a stop the app saw itself.
    const g = DEP.createDepartures();
    g.update([skyhawk({ onGround: true })], T - 30 * MIN);
    g.update([skyhawk({ lat: 41.3, lon: -83.7, altitudeFt: 3000, groundSpeedKt: 100 })], T - 20 * MIN);
    g.set('a1b2c3', delaware, T);
    assert.match(g.line('a1b2c3', T), /^From Wood County/);
  });

} catch (e) {
  console.error(e);
  failed++;
} finally {
  await vite.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
