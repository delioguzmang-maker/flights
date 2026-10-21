// Runs delta_fare_finder.js in a sandbox with a fake fetch built from the
// response recorded in the HAR capture. Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const script = readFileSync(new URL('delta_fare_finder.js', root), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('tests/fixtures/flex_roundtrip_CHS_MXP.json', root), 'utf8'));

// Deterministic per-airport surcharge so routes rank predictably; unlisted airports +40.
const SURCHARGE = { CHS: 0, CAE: 40, GSP: 60, CLT: -30, FRA: 10, MUC: -50, BER: 30, DUS: 20, HAM: 25, STR: 35, FCO: -20, MXP: 0, VCE: 15, BLQ: 45, FLR: 50, AMS: -90, ATL: -120 };
const s = code => SURCHARGE[code] ?? 40;
const HOMES = ['CHS', 'CAE', 'GSP', 'CLT'];
const GERMANY = ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR', 'NUE', 'CGN', 'LEJ', 'HAJ'];
// Settings that switch off everything v1 of the script didn't do (including drive costs).
const BASIC = { moreAirports: {}, extraHomeAirports: [], searchNearbyAirports: false, otherWeeks: false, drive: false };
// Drive + parking as the script computes it with the default CONFIG.drive.
const DRIVE = { CAE: [10, 12], CLT: [95, 14], GSP: [95, 10], CHS: [115, 13], AGS: [75, 10], SAV: [160, 7], ATL: [215, 14], MYR: [150, 12], AVL: [160, 12], RDU: [225, 10] };
const ground = (airport, nights) => Math.round((2 * DRIVE[airport][0] * 3) / 28 + DRIVE[airport][1] * (nights + 1));

const plain = x => JSON.parse(JSON.stringify(x)); // copy out of the vm realm for deepEqual
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const daysFrom = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

// The recorded 7×7 grid (centred on Dec 17 / Dec 25), moved to the requested dates and
// repriced: + delta, and whole weeks earlier cost $40/week less, later $50/week more.
function grid(legs, delta, tripTypeText) {
  const copy = structuredClone(fixture.response);
  const outShift = daysFrom('2026-12-17', legs[0].departureLocalTs.slice(0, 10));
  const retShift = daysFrom('2026-12-25', legs[1].departureLocalTs.slice(0, 10));
  const weeks = Math.round(outShift / 7);
  const weekDelta = weeks < 0 ? 40 * weeks : 50 * weeks;
  const g = copy.data.gqlSearchOffers;
  for (const set of g.gqlOffersSets) {
    set.itineraryDepartureDate = shift(set.itineraryDepartureDate, outShift);
    for (const offer of set.offers) {
      const price = offer.offerPricing[0].totalAmt.currencyEquivalentPrice;
      price.currencyAmt = Math.round((price.currencyAmt + delta + weekDelta) * 100) / 100;
    }
  }
  g.offerDataList.flexReturnDates = g.offerDataList.flexReturnDates.map(d => shift(d, retShift));
  if (tripTypeText) g.offerDataList.responseProperties.tripTypeText = tripTypeText;
  return copy;
}

// One-way grid: 7 sets, each with 7 offers; only offers[i] in set i is the real fare
// (that's how delta.com reads it), the rest are decoys.
const oneWayGrid = (base, center) => ({
  data: {
    gqlSearchOffers: {
      offerResponseId: 'x',
      gqlOffersSets: Array.from({ length: 7 }, (_, i) => ({
        itineraryDepartureDate: shift(center.slice(0, 10), i - 3),
        offers: Array.from({ length: 7 }, (_, j) => ({
          offerId: `o${i}${j}`,
          additionalOfferProperties: { offered: null, soldOut: i === 3 ? true : null, lowestFare: false, totalTripStopCnt: 1, discountAvailable: false },
          offerPricing: [{ totalAmt: { currencyEquivalentPrice: { currencyAmt: j === i ? base + i * 10 : 1 } } }],
        })),
      })),
      offerDataList: { pricingOptions: [{ pricingOptionDetail: { currencyCode: 'USD' } }], flexReturnDates: [], responseProperties: { tripTypeText: 'ONE_WAY' } },
    },
  },
});

// Nearby-airports grid as the site's parser reads it: rows = origin airports, columns =
// flexDestinationAirportCodes. GSO turns up near the home airport; SZG / BGY near Europe.
const nearbyGrid = (from, to) => {
  const origins = [from, 'GSO'];
  const destinations = [to, GERMANY.includes(to) ? 'SZG' : 'BGY'];
  return {
    data: {
      gqlSearchOffers: {
        offerResponseId: 'n',
        gqlOffersSets: origins.map(o => ({
          originAirportCode: o,
          offers: destinations.map(d => ({
            soldOut: false,
            offerPricing: [{ totalAmt: { currencyEquivalentPrice: { roundedCurrencyAmt: 0, formattedCurrencyAmt: String(700 + s(o) + s(d)) } } }],
            additionalOfferProperties: { lowestFare: false, offered: null, discountAvailable: false },
          })),
        })),
        offerDataList: { flexDestinationAirportCodes: destinations, pricingOptions: [{ pricingOptionDetail: { currencyCode: 'USD' } }], responseProperties: { tripTypeText: 'ROUND_TRIP' } },
      },
    },
  };
};

const ERROR = (code, more) => ({ errors: [{ message: 'error', extensions: { errors: { code, moreInfo: [{ code: more }] } } }], data: { gqlSearchOffers: null } });

function makeSandbox({ config = {}, storage = new Map(), openJawUnsupported = false, nearbyUnsupported = false, override = null } = {}) {
  const calls = [];
  const logs = [];
  const downloads = [];
  const callbacks = new Map();

  const json = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });

  async function fetch(url, init = {}) {
    calls.push({ url, init });
    if (url.startsWith('https://offer-api-prd.delta.com/prd/callback/')) {
      assert.equal(init.headers.Authorization, 'GUEST');
      const id = decodeURIComponent(url.split('/').pop());
      assert.ok(callbacks.has(id), `unknown callback ${id}`);
      return json(callbacks.get(id));
    }
    assert.equal(url, 'https://offer-api-prd.delta.com/prd/rm-offer-gql');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'include');
    const h = init.headers;
    assert.equal(h.Authorization, 'GUEST');
    assert.equal(h.applicationId, 'DC');
    assert.equal(h.channelId, 'DCOM');
    assert.equal(h.Airline, 'DL');
    assert.equal(h['x-app-type'], 'dcom-shop');
    assert.match(h.TransactionId, /^[0-9a-f-]{36}_\d+$/);

    const body = JSON.parse(init.body);
    const legs = body.variables.offerSearchCriteria.offersCriteria.flightRequestCriteria.searchOriginDestination;
    const a = legs[0].origins[0].airportCode;
    const b = legs[0].destinations[0].airportCode;
    const custom = override && override(legs, calls.length);
    if (custom) return custom;

    if (h['x-app-route'] === 'airport') {
      assert.match(body.query, /flexDestinationAirportCodes/);
      for (const l of legs) {
        assert.deepEqual(l.origins[0].airportRadiusMileCnt, { unitOfMeasure: 'MI', unitOfMeasureCnt: 100 });
        assert.deepEqual(l.destinations[0].airportRadiusMileCnt, { unitOfMeasure: 'MI', unitOfMeasureCnt: 100 });
        assert.equal(l.calenderDateRequest, undefined);
      }
      return json(nearbyUnsupported ? ERROR('ROF4002', '200') : nearbyGrid(a, b));
    }
    assert.equal(h['x-app-route'], 'dates');
    assert.equal(body.query, fixture.query);

    if (legs.length === 1) {
      const europe = HOMES.includes(a) || a === 'ATL' ? b : a;
      const home = europe === a ? b : a;
      return json(oneWayGrid(520 + s(europe) + s(home), legs[0].departureLocalTs));
    }
    const c = legs[1].origins[0].airportCode;
    const d = legs[1].destinations[0].airportCode;
    if (b === 'NAP' || c === 'NAP') return json(ERROR('ROF4002', '404'));
    if (b === c && a === d) return json(grid(legs, s(a) + s(b)));

    // Open-jaw: answer through the callback flow.
    if (openJawUnsupported) return json(ERROR('ROF4002', '210'));
    const id = `cb-${a}-${b}-${c}-${d}-${legs[0].departureLocalTs}`;
    const intoItaly = GERMANY.includes(b) ? 0 : 25; // break the tie between the two directions
    callbacks.set(id, grid(legs, s(a) + s(b) + s(c) - 150 + intoItaly, 'MULTI_CITY'));
    return json({ errors: [{ message: 'pending', extensions: { errors: { code: 'ROF5004', moreInfo: [{ code: 'PXY1007', callbackId: id, callbackInSecs: 2 }] } } }] });
  }

  const record = (...args) => logs.push(args.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const context = {
    console: { log: record, warn: record, error: record, table: record },
    fetch,
    location: { hostname: 'www.delta.com' },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: {
      createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }),
      body: { appendChild() {} },
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob,
    crypto: globalThis.crypto,
    Intl,
    structuredClone,
    setTimeout: fn => setImmediate(fn), // skip real waits
    DELTA_FARE_CONFIG: { delayMs: [0, 0], ...config },
  };
  context.window = context;
  vm.createContext(context);
  const posts = route => calls.filter(c => c.init.method === 'POST' && (!route || c.init.headers['x-app-route'] === route));
  const legsOf = c => JSON.parse(c.init.body).variables.offerSearchCriteria.offersCriteria.flightRequestCriteria.searchOriginDestination;
  return { context, calls, logs, downloads, storage, posts, legsOf, run: () => vm.runInContext(script, context) };
}

test('request body matches what delta.com sent in the HAR', async () => {
  const sb = makeSandbox({ config: { ...BASIC, homeAirports: ['CHS'], destinations: { Italy: ['MXP'] }, visitCountries: ['Italy'], searchOneWays: false, searchOpenJaw: false } });
  await sb.run();
  assert.equal(sb.calls.length, 1);
  const body = JSON.parse(sb.calls[0].init.body);
  assert.deepEqual(body.variables, fixture.request);
  assert.equal(body.query, fixture.query);
});

test('round trips, open-jaws and one-way pairs on your dates', async () => {
  const sb = makeSandbox({ config: BASIC });
  await sb.run();
  const { rows, trips, bestPerRoute, csv } = plain(sb.context.deltaFares);

  const rt = 4 * 12; // homes × destinations, one 7×7 block
  const oj = 4 * 3 * 3 * 2; // homes × gateways DE × gateways IT × direction
  const ow = 2 * 6 * 2; // 2 cheapest homes × gateways × out/back
  assert.equal(sb.posts().length, rt + oj + ow);
  assert.equal(sb.calls.length - sb.posts().length, oj, 'one callback poll per open-jaw search');

  // RT grid parsed like delta.com: 7×7, every cell priced in the fixture.
  const chsMxp = rows.filter(r => r.kind === 'RT' && r.from === 'CHS' && r.to === 'MXP');
  assert.equal(chsMxp.length, 49);
  assert.deepEqual(
    chsMxp.find(r => r.out === '2026-12-14' && r.ret === '2026-12-22'),
    { kind: 'RT', from: 'CHS', to: 'MXP', from2: 'MXP', to2: 'CHS', out: '2026-12-14', ret: '2026-12-22', price: 831.59, stops: 1 },
  );
  assert.equal(chsMxp.find(r => r.out === '2026-12-20' && r.ret === '2026-12-28').price, 1604.59);

  // NAP returned an error, so it has no fares and doesn't break the run.
  assert.equal(rows.filter(r => r.to === 'NAP' || r.from === 'NAP').length, 0);

  // One-ways only from the two cheapest home airports (CLT, CHS); diagonal read, sold-out day dropped.
  assert.deepEqual([...new Set(rows.filter(r => r.kind === 'OW-out').map(r => r.from))].sort(), ['CHS', 'CLT']);
  const ow1 = rows.filter(r => r.kind === 'OW-out' && r.from === 'CLT' && r.to === 'MUC');
  assert.deepEqual(ow1.map(r => r.out), ['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-18', '2026-12-19', '2026-12-20']);
  assert.ok(ow1.every(r => r.price > 100), 'decoy prices must not be used');

  // Gateways chosen from the RT scan: cheapest German = MUC, FRA, DUS; Italian = FCO, MXP, VCE.
  const ojAirports = new Set(rows.filter(r => r.kind === 'OJ').flatMap(r => [r.to, r.from2]));
  assert.deepEqual([...ojAirports].sort(), ['DUS', 'FCO', 'FRA', 'MUC', 'MXP', 'VCE']);

  // Cheapest overall is the open-jaw CLT → MUC … FCO → CLT: fixture min 831.59, minus the
  // CLT/MUC/FCO surcharges and the open-jaw discount, plus one 75 hop.
  const top = bestPerRoute[0];
  assert.deepEqual([top.strategy, top.route, top.hops, top.yourDates], ['Open-jaw', 'CLT → MUC … FCO → CLT', 1, true]);
  assert.equal(Math.round(top.total * 100), Math.round((831.59 - 30 - 50 - 20 - 150 + 75) * 100));

  // Round trip into Germany needs two hops to also see Italy.
  const rtTrip = trips.find(t => t.strategy === 'Round trip' && t.to === 'MUC');
  assert.equal(rtTrip.hops, 2);
  assert.equal(rtTrip.total, rtTrip.airfare + 150);

  const keys = bestPerRoute.map(t => [t.strategy, t.from, t.to, t.from2, t.to2].join('|'));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(bestPerRoute.every((t, i) => i === 0 || bestPerRoute[i - 1].total <= t.total));
  assert.ok(trips.filter(t => t.strategy === 'Two one-ways').every(t => t.from === t.to2));
  assert.ok(trips.every(t => t.yourDates));

  assert.ok(csv.startsWith('strategy,route,from,to,from2,to2,out,ret,nights,stops,airfare,driveAndPark,hops,total,yourDates\n'));
  assert.equal(sb.downloads.length, 2);
  assert.ok(sb.logs.some(l => l.includes('How to book')));
});

test('default plan also tries more airports, nearby airports, more home airports and other weeks', async () => {
  const sb = makeSandbox();
  await sb.run();
  const fares = plain(sb.context.deltaFares);
  const { rows, trips, bestPerRoute, otherDates, discovered } = fares;
  const legsOf = c => sb.legsOf(c).map(l => [l.origins[0].airportCode, l.destinations[0].airportCode, l.departureLocalTs.slice(0, 10)]);
  const dates = sb.posts('dates').map(legsOf);

  // More airports: from the two cheapest homes (CLT, CHS) to every extra airport.
  const more = ['NUE', 'CGN', 'LEJ', 'HAJ', 'PSA', 'LIN', 'TRN', 'BRI', 'CTA', 'AMS', 'CDG', 'MAD', 'BCN', 'ZRH', 'VIE', 'DUB', 'LIS'];
  for (const a of more) {
    assert.deepEqual(dates.filter(l => l.length === 2 && l[0][1] === a && l[1][1] === l[0][0]).map(l => l[0][0]).sort(), ['CHS', 'CLT'], a);
  }
  // A third country costs one more hop: a round trip to Amsterdam needs 3.
  const ams = trips.find(t => t.strategy === 'Round trip' && t.to === 'AMS');
  assert.equal(ams.hops, 3);

  // Nearby airports: one search per top home × visit country, on that route's best dates.
  const nearby = sb.posts('airport').map(legsOf);
  assert.equal(nearby.length, 4);
  assert.deepEqual(nearby.map(l => l[0][0]).sort(), ['CHS', 'CHS', 'CLT', 'CLT']);
  assert.deepEqual(discovered.sort(), ['BGY', 'SZG']);
  // GSO turned up on the home side, but with no drive cost it's only reported, not ranked.
  assert.ok(!rows.some(r => r.from === 'GSO'));
  assert.ok(sb.logs.some(l => l.includes('It also lists these airports near yours') && l.includes('GSO')));
  assert.ok(rows.some(r => r.kind === 'RT' && r.to === 'SZG'));
  assert.equal(trips.find(t => t.to === 'SZG' && t.strategy === 'Round trip').hops, 2, 'SZG counts as Germany (it is near MUC)');

  // More home airports: each extra home × the 6 gateways, with its own drive and parking cost.
  for (const h of ['ATL', 'AGS', 'SAV', 'MYR', 'AVL', 'RDU']) assert.equal(dates.filter(l => l[0][0] === h).length, 6, h);
  const atlTrip = trips.find(t => t.from === 'ATL');
  assert.equal(atlTrip.driveAndPark, ground('ATL', atlTrip.nights));
  assert.equal(atlTrip.total, atlTrip.airfare + atlTrip.hops * 75 + ground('ATL', atlTrip.nights));
  assert.ok(sb.logs.some(l => l.includes('Best trip from each home airport')));

  // Other weeks: the 5 cheapest routes on your dates, the searched block moved −3…+3 weeks,
  // so the shifted grids tile with it (Dec 10, Dec 3, Nov 26 / Dec 24, Dec 31, Jan 7 centres).
  const shifted = dates.filter(l => l.length === 2 && l[0][2] !== '2026-12-17'); // your-dates grids are centred on Dec 17
  assert.equal(shifted.length, 5 * 6);
  assert.deepEqual([...new Set(shifted.map(l => l[0][2]))].sort(), ['2026-11-26', '2026-12-03', '2026-12-10', '2026-12-24', '2026-12-31', '2027-01-07']);
  assert.ok(otherDates.length > 0);
  assert.ok(otherDates.every(t => !t.yourDates));
  const earliest = otherDates[0];
  assert.ok(earliest.out < '2026-12-01', earliest.out);
  const sameRouteYourDates = bestPerRoute.find(t => t.strategy === earliest.strategy && t.route === earliest.route);
  assert.equal(Math.round(sameRouteYourDates.total - earliest.total), 120, '3 weeks earlier saves 3 × $40');
  assert.ok(otherDates.every(t => t.total < bestPerRoute[0].total), 'only moves that beat your best option');
  assert.ok(sb.logs.some(l => l.includes('Cheaper if you can move the trip')));
  assert.ok(bestPerRoute.every(t => t.yourDates));
  assert.ok(sb.logs.some(l => l.includes('Cheapest round trip to each European airport')));
});

test('est. total includes gas and parking from Columbia; dropOff and extra costs', async () => {
  const sb = makeSandbox({ config: { ...BASIC, drive: undefined, searchOpenJaw: false, searchOneWays: false } });
  delete sb.context.DELTA_FARE_CONFIG.drive; // use the default Columbia drive table
  await sb.run();
  const { trips } = plain(sb.context.deltaFares);
  for (const h of ['CAE', 'CLT', 'GSP', 'CHS']) {
    const t = trips.find(x => x.from === h);
    assert.equal(t.driveAndPark, ground(h, t.nights), h);
    assert.equal(t.total, t.airfare + t.hops * 75 + ground(h, t.nights), h);
  }
  // 8 nights at CAE: 20 miles of gas ($2) + 9 days × $12 parking = $110.
  assert.equal(trips.find(t => t.from === 'CAE' && t.nights === 8).driveAndPark, 110);
  assert.ok(sb.logs.some(l => l.startsWith('Drive + parking for a 8-night trip: CAE $110 · CLT $146 · GSP $110 · CHS $142')));

  // Overriding just dropOff keeps the airport table (drive is merged, not replaced).
  const dropped = makeSandbox({ config: { ...BASIC, searchOpenJaw: false, searchOneWays: false, homeAirportExtraCost: { CLT: 40 }, drive: { dropOff: true } } });
  await dropped.run();
  const clt = plain(dropped.context.deltaFares.trips).find(t => t.from === 'CLT');
  assert.equal(clt.driveAndPark, Math.round((4 * 95 * 3) / 28 + 40)); // two round trips of gas, no parking, + extra

  // An airport with no drive figures is flagged.
  const unknown = makeSandbox({ config: { ...BASIC, drive: undefined, homeAirports: ['CAE', 'GSO'], searchOpenJaw: false, searchOneWays: false } });
  delete unknown.context.DELTA_FARE_CONFIG.drive;
  await unknown.run();
  assert.ok(unknown.logs.some(l => l.includes('No drive/parking figures for GSO')));
});

test('with round trips off, open-jaws still use the main airports', async () => {
  const sb = makeSandbox({ config: { searchRoundTrips: false, searchOneWays: false, searchNearbyAirports: false, extraHomeAirports: [], otherWeeks: false } });
  await sb.run();
  const oj = plain(sb.context.deltaFares.rows).filter(r => r.kind === 'OJ');
  assert.deepEqual([...new Set(oj.flatMap(r => [r.to, r.from2]))].sort(), ['BER', 'FCO', 'FRA', 'MUC', 'MXP', 'VCE']);
});

test('server errors are not cached and five in a row stop the run; callback time-outs do not skip a phase', async () => {
  const storage = new Map();
  let n = 0;
  // Searches 3 and 4 fail with HTTP 500 (non-JSON); everything else works.
  const flaky = makeSandbox({ storage, config: BASIC, override: () => (++n === 3 || n === 4 ? { status: 500, ok: false, json: async () => { throw new Error('html'); } } : null) });
  await flaky.run();
  assert.ok(flaky.logs.some(l => l.includes('no fares (HTTP 500)')));
  const again = makeSandbox({ storage, config: BASIC });
  await again.run();
  assert.equal(again.calls.length, 2, 'only the two failed searches are re-sent');

  const down = makeSandbox({ config: BASIC, override: () => ({ status: 500, ok: false, json: async () => ({ errors: [{ message: 'Internal error' }] }) }) });
  await down.run();
  assert.equal(down.calls.length, 5);
  assert.ok(down.logs.some(l => l.includes('the last 5 searches failed (now in "Round trips")')));

  // A phase that keeps failing without a Delta code (here the nearby search, HTTP 400) is
  // skipped after 3, and the run carries on instead of tripping the 5-in-a-row stop.
  const rejected = makeSandbox({
    config: { exploreFromTopHomes: 3, searchOneWays: false, extraHomeAirports: [], otherWeeks: false },
    override: legs => (legs[0].origins[0].airportRadiusMileCnt ? { status: 400, ok: false, json: async () => { throw new Error('html'); } } : null),
  });
  await rejected.run();
  assert.ok(rejected.logs.some(l => l.includes('Nearby airports: the first 3 searches all failed')));
  assert.ok(!rejected.logs.some(l => l.includes('Stopped early')));
  assert.ok(plain(rejected.context.deltaFares.rows).some(r => r.kind === 'OJ'));

  // Open-jaw callbacks that never finish: transient, so the phase isn't written off after 3.
  let polls = 0;
  const slow = makeSandbox({
    config: { ...BASIC, searchOneWays: false },
    override: legs => (legs.length === 2 && legs[1].origins[0].airportCode !== legs[0].destinations[0].airportCode && ++polls <= 3
      ? { status: 200, ok: true, json: async () => ({ errors: [{ message: 'pending', extensions: { errors: { code: 'ROF5004', moreInfo: [{ code: 'PXY1007', callbackId: 'never', callbackInSecs: 1 }] } } }] }) }
      : null),
  });
  slow.context.fetch = (orig => async (url, init) => (url.endsWith('/never')
    ? { status: 200, ok: true, json: async () => ({ errors: [{ message: 'pending', extensions: { errors: { code: 'ROF5004', moreInfo: [{ code: 'PXY1007', callbackId: 'never', callbackInSecs: 1 }] } } }] }) }
    : orig(url, init)))(slow.context.fetch);
  await slow.run();
  assert.ok(!slow.logs.some(l => l.includes('Skipping the rest')));
  assert.ok(plain(slow.context.deltaFares.rows).some(r => r.kind === 'OJ'));
});

test('second run is served from the cache', async () => {
  const storage = new Map();
  const first = makeSandbox({ storage });
  await first.run();
  const second = makeSandbox({ storage });
  await second.run();
  assert.equal(second.calls.length, 0);
  assert.equal(second.context.deltaFares.bestPerRoute[0].route, first.context.deltaFares.bestPerRoute[0].route);
});

test('phases the API rejects are skipped after three failures', async () => {
  const sb = makeSandbox({ openJawUnsupported: true, nearbyUnsupported: true, config: { searchOneWays: false } });
  await sb.run();
  const ojPosts = sb.posts('dates').filter(c => {
    const legs = sb.legsOf(c);
    return legs.length === 2 && legs[1].origins[0].airportCode !== legs[0].destinations[0].airportCode;
  });
  assert.equal(ojPosts.length, 3);
  assert.equal(sb.posts('airport').length, 3);
  assert.equal(sb.logs.filter(l => l.includes('Skipping the rest')).length, 2);
  assert.ok(sb.context.deltaFares.trips.length > 0);
});

test('mixHomeAirports pairs one-ways across home airports and stop flag halts cleanly', async () => {
  // One-ways come from the two cheapest homes (CLT, CHS); leaving CLT and coming home to CHS
  // averages the two airports' costs (0 and 20).
  const sb = makeSandbox({ config: { ...BASIC, searchOpenJaw: false, mixHomeAirports: true, homeAirportExtraCost: { CHS: 20 } } });
  await sb.run();
  const mixed = plain(sb.context.deltaFares.trips).filter(t => t.strategy === 'Two one-ways' && t.from !== t.to2);
  assert.ok(mixed.length > 0);
  const t = mixed.find(x => x.from === 'CLT' && x.to2 === 'CHS');
  assert.equal(t.total, t.airfare + t.hops * 75 + 10);

  // A stop flag left over from an earlier run is cleared; setting it mid-run stops after
  // the current search and still ranks what was found.
  const stopped = makeSandbox({ config: BASIC });
  stopped.context.DELTA_FARE_STOP = true;
  const realFetch = stopped.context.fetch;
  stopped.context.fetch = (...args) => {
    stopped.context.DELTA_FARE_STOP = true;
    return realFetch(...args);
  };
  await stopped.run();
  assert.equal(stopped.calls.length, 1);
  assert.ok(stopped.logs.some(l => l.includes('Stopped early')));
  assert.equal(plain(stopped.context.deltaFares.bestPerRoute)[0].route, 'CAE ⇄ FRA');
});

test('refuses to run off delta.com and when the plan exceeds maxRequests', async () => {
  const off = makeSandbox();
  off.context.location.hostname = 'example.com';
  await off.run();
  assert.equal(off.calls.length, 0);

  const big = makeSandbox({ config: { departDates: ['2026-12-01', '2026-12-31'], returnDates: ['2027-01-01', '2027-01-31'], maxNights: 60 } });
  await big.run();
  assert.equal(big.calls.length, 0);
  assert.ok(big.logs.some(l => l.includes('more than maxRequests')));
});
