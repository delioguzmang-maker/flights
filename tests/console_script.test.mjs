// Runs delta_fare_finder.js in a sandbox with a fake fetch built from the
// response recorded in the HAR capture. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const script = readFileSync(new URL('delta_fare_finder.js', root), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('tests/fixtures/flex_roundtrip_CHS_MXP.json', root), 'utf8'));

// Deterministic per-airport surcharge so routes rank predictably.
const surcharge = { CHS: 0, CAE: 40, GSP: 60, CLT: -30, FRA: 10, MUC: -50, BER: 30, DUS: 20, HAM: 25, STR: 35, FCO: -20, MXP: 0, VCE: 15, BLQ: 45, FLR: 50 };

const GERMANY = ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR'];
const plain = x => JSON.parse(JSON.stringify(x)); // copy out of the vm realm for deepEqual

const scaled = (response, delta, tripTypeText) => {
  const copy = structuredClone(response);
  for (const set of copy.data.gqlSearchOffers.gqlOffersSets) {
    for (const offer of set.offers) {
      const price = offer.offerPricing[0].totalAmt.currencyEquivalentPrice;
      price.currencyAmt = Math.round((price.currencyAmt + delta) * 100) / 100;
    }
  }
  if (tripTypeText) copy.data.gqlSearchOffers.offerDataList.responseProperties.tripTypeText = tripTypeText;
  return copy;
};

// One-way grid: 7 sets, each with 7 offers; only offers[i] in set i is the real fare
// (that's how delta.com reads it), the rest are decoys.
const oneWayGrid = (base, center) => ({
  data: {
    gqlSearchOffers: {
      offerResponseId: 'x',
      gqlOffersSets: Array.from({ length: 7 }, (_, i) => ({
        itineraryDepartureDate: new Date(Date.parse(`${center}Z`) + (i - 3) * 864e5).toISOString().slice(0, 10),
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

function makeSandbox({ config = {}, storage = new Map(), openJawUnsupported = false } = {}) {
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
    assert.equal(h['x-app-route'], 'dates');
    assert.equal(h['x-app-type'], 'dcom-shop');
    assert.match(h.TransactionId, /^[0-9a-f-]{36}_\d+$/);

    const body = JSON.parse(init.body);
    assert.equal(body.query, fixture.query);
    const legs = body.variables.offerSearchCriteria.offersCriteria.flightRequestCriteria.searchOriginDestination;
    const a = legs[0].origins[0].airportCode;
    const b = legs[0].destinations[0].airportCode;

    if (legs.length === 1) {
      const europe = surcharge[a] !== undefined && !['CHS', 'CAE', 'GSP', 'CLT'].includes(a) ? a : b;
      return json(oneWayGrid(520 + surcharge[europe] + (surcharge[a === europe ? b : a] || 0), legs[0].departureLocalTs));
    }
    const c = legs[1].origins[0].airportCode;
    const d = legs[1].destinations[0].airportCode;
    if (b === 'NAP' || c === 'NAP') {
      return json({ errors: [{ message: 'no service', extensions: { errors: { code: 'ROF4002', moreInfo: [{ code: '404' }] } } }], data: { gqlSearchOffers: null } });
    }
    if (b === c && a === d) return json(scaled(fixture.response, surcharge[a] + surcharge[b]));

    // Open-jaw: answer through the callback flow.
    if (openJawUnsupported) {
      return json({ errors: [{ message: 'bad trip', extensions: { errors: { code: 'ROF4002', moreInfo: [{ code: '210' }] } } }] });
    }
    const id = `cb-${a}-${b}-${c}-${d}`;
    const intoItaly = !GERMANY.includes(b) ? 25 : 0; // break the tie between the two directions
    callbacks.set(id, scaled(fixture.response, surcharge[a] + surcharge[b] + surcharge[c] - 150 + intoItaly, 'MULTI_CITY'));
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
  return { context, calls, logs, downloads, storage, run: () => vm.runInContext(script, context) };
}

test('request body matches what delta.com sent in the HAR', async () => {
  const sb = makeSandbox({ config: { homeAirports: ['CHS'], destinations: { Italy: ['MXP'] }, visitCountries: ['Italy'], searchOneWays: false, searchOpenJaw: false } });
  await sb.run();
  assert.equal(sb.calls.length, 1);
  const body = JSON.parse(sb.calls[0].init.body);
  assert.deepEqual(body.variables, fixture.request);
});

test('full default run ranks round trips, open-jaws and one-way pairs', async () => {
  const sb = makeSandbox();
  await sb.run();
  const { rows, trips, bestPerRoute, csv } = plain(sb.context.deltaFares);

  const posts = sb.calls.filter(c => c.init.method === 'POST');
  const rt = 4 * 12; // homes × destinations, one 7×7 block
  const oj = 4 * 3 * 3 * 2; // homes × gateways DE × gateways IT × direction
  const ow = 4 * 6 * 2; // homes × gateways × out/back
  assert.equal(posts.length, rt + oj + ow);
  assert.equal(sb.calls.length - posts.length, oj, 'one callback poll per open-jaw search');

  // RT grid parsed like delta.com: 7×7, minus nothing (fixture has every cell priced).
  const chsMxp = rows.filter(r => r.kind === 'RT' && r.from === 'CHS' && r.to === 'MXP');
  assert.equal(chsMxp.length, 49);
  assert.deepEqual(
    chsMxp.find(r => r.out === '2026-12-14' && r.ret === '2026-12-22'),
    { kind: 'RT', from: 'CHS', to: 'MXP', from2: 'MXP', to2: 'CHS', out: '2026-12-14', ret: '2026-12-22', price: 831.59, stops: 1 },
  );
  assert.equal(chsMxp.find(r => r.out === '2026-12-20' && r.ret === '2026-12-28').price, 1604.59);

  // NAP returned an error, so it has no fares and doesn't break the run.
  assert.equal(rows.filter(r => r.to === 'NAP' || r.from === 'NAP').length, 0);

  // One-way grid uses the diagonal and drops the sold-out day.
  const ow1 = rows.filter(r => r.kind === 'OW-out' && r.from === 'CLT' && r.to === 'MUC');
  assert.deepEqual(ow1.map(r => r.out), ['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-18', '2026-12-19', '2026-12-20']);
  assert.ok(ow1.every(r => r.price > 100), 'decoy prices must not be used');

  // Gateways chosen from the RT scan: cheapest German = MUC, FRA, DUS; Italian = FCO, MXP, VCE.
  const ojAirports = new Set(rows.filter(r => r.kind === 'OJ').flatMap(r => [r.to, r.from2]));
  assert.deepEqual([...ojAirports].sort(), ['DUS', 'FCO', 'FRA', 'MUC', 'MXP', 'VCE']);

  // Cheapest overall is the open-jaw CLT → MUC … FCO → CLT: fixture min 831.59, minus the
  // CLT/MUC/FCO surcharges and the open-jaw discount, plus one 75 hop.
  const top = bestPerRoute[0];
  assert.equal(top.strategy, 'Open-jaw');
  assert.equal(top.route, 'CLT → MUC … FCO → CLT');
  assert.equal(top.hops, 1);
  assert.equal(Math.round(top.total * 100), Math.round((831.59 - 30 - 50 - 20 - 150 + 75) * 100));

  // Round trip into Germany needs two hops to also see Italy.
  const rtTrip = trips.find(t => t.strategy === 'Round trip' && t.to === 'MUC');
  assert.equal(rtTrip.hops, 2);
  assert.equal(rtTrip.total, rtTrip.airfare + 150);

  // bestPerRoute has one entry per route, sorted.
  const keys = bestPerRoute.map(t => [t.strategy, t.from, t.to, t.from2, t.to2].join('|'));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(bestPerRoute.every((t, i) => i === 0 || bestPerRoute[i - 1].total <= t.total));

  // One-way pairs come home to the same airport unless mixHomeAirports is on.
  assert.ok(trips.filter(t => t.strategy === 'Two one-ways').every(t => t.from === t.to2));

  assert.ok(csv.startsWith('strategy,route,from,to,from2,to2,out,ret,nights,stops,airfare,hops,total\n'));
  assert.equal(sb.downloads.length, 2);
  assert.ok(sb.logs.some(l => l.includes('How to book')));
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

test('open-jaw phase is skipped when the API rejects multi-city grids', async () => {
  const sb = makeSandbox({ openJawUnsupported: true, config: { searchOneWays: false } });
  await sb.run();
  const ojPosts = sb.calls.filter(c => JSON.parse(c.init.body).variables.offerSearchCriteria.offersCriteria.flightRequestCriteria.searchOriginDestination
    .reduce((acc, l, i, legs) => acc || (i === 1 && l.origins[0].airportCode !== legs[0].destinations[0].airportCode), false));
  assert.equal(ojPosts.length, 3);
  assert.ok(sb.logs.some(l => l.includes('Skipping the rest')));
  assert.ok(sb.context.deltaFares.trips.length > 0);
});

test('mixHomeAirports pairs one-ways across home airports and stop flag halts cleanly', async () => {
  const sb = makeSandbox({ config: { searchOpenJaw: false, mixHomeAirports: true, homeAirportExtraCost: { CHS: 0, CAE: 0, GSP: 0, CLT: 100 } } });
  await sb.run();
  const mixed = plain(sb.context.deltaFares.trips).filter(t => t.strategy === 'Two one-ways' && t.from !== t.to2);
  assert.ok(mixed.length > 0);
  const t = mixed.find(x => x.from === 'CLT' && x.to2 === 'CHS');
  assert.equal(t.total, t.airfare + t.hops * 75 + 50);

  // A stop flag left over from an earlier run is cleared; setting it mid-run stops after
  // the current search and still ranks what was found.
  const stopped = makeSandbox();
  stopped.context.DELTA_FARE_STOP = true;
  const realFetch = stopped.context.fetch;
  stopped.context.fetch = (...args) => {
    stopped.context.DELTA_FARE_STOP = true;
    return realFetch(...args);
  };
  await stopped.run();
  assert.equal(stopped.calls.length, 1);
  assert.ok(stopped.logs.some(l => l.includes('Stopped early')));
  assert.equal(plain(stopped.context.deltaFares.bestPerRoute)[0].route, 'CHS ⇄ FRA');
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
