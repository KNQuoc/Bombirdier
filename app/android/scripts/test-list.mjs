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
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await vite.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
