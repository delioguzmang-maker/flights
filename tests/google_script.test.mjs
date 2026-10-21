// Runs google_flights_finder.js in a sandbox against a fake google.com that serves results
// pages built from the page recorded in the HAR capture. Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const script = readFileSync(new URL('google_flights_finder.js', root), 'utf8');
const capturedPage = readFileSync(new URL('tests/fixtures/gf_search_page.html', root), 'utf8');
const capturedUrl = readFileSync(new URL('tests/fixtures/gf_search_url.txt', root), 'utf8').trim();
const plain = x => JSON.parse(JSON.stringify(x)); // copy out of the vm realm for deepEqual

const HOMES = ['CAE', 'CLT', 'GSP', 'CHS'];
const EACH_HOME = ['CAE', 'CLT', 'GSP', 'CHS', 'AGS', 'SAV', 'ATL', 'MYR', 'AVL', 'RDU'];
const US_HUBS = ['JFK', 'EWR', 'BOS', 'IAD', 'PHL', 'MCO', 'MIA'];
const US = new Set([...EACH_HOME, ...US_HUBS]);
// Only the date-grid phase, as the first version of the script did.
const GRID_ONLY = { morePlaces: {}, eachHomeAirport: [], usHubs: [], otherWeeks: [] };
// Drive + parking with the default CONFIG.drive.
const DRIVE = { CAE: [10, 12], CLT: [95, 14], GSP: [95, 10], CHS: [115, 13], AGS: [75, 10], SAV: [160, 7], ATL: [215, 14], MYR: [150, 12], AVL: [160, 12], RDU: [225, 10] };
const ground = (a, nights) => (DRIVE[a] ? Math.round((2 * DRIVE[a][0] * 3) / 28 + DRIVE[a][1] * (nights + 1)) : 0);

// Decode a tfs= search URL into its fields (inverse of the script's encoder).
function decodeSearch(link) {
  const tfs = new URL(link).searchParams.get('tfs');
  const bytes = [...Buffer.from(tfs.replace(/-/g, '+').replace(/_/g, '/'), 'base64')];
  const read = (b, i) => { let v = 0; let s = 1; for (;;) { const c = b[i++]; v += (c & 127) * s; s *= 128; if (c < 128) return [v, i]; } };
  const fields = b => {
    const out = [];
    for (let i = 0; i < b.length;) {
      let key;
      [key, i] = read(b, i);
      if ((key & 7) === 0) { let v; [v, i] = read(b, i); out.push([key >> 3, v]); } else { let n; [n, i] = read(b, i); out.push([key >> 3, b.slice(i, i + n)]); i += n; }
    }
    return out;
  };
  const text = b => Buffer.from(b).toString();
  const top = fields(bytes);
  return {
    trip: top.find(f => f[0] === 19)[1],
    adults: top.filter(f => f[0] === 8).length,
    seat: top.find(f => f[0] === 9)[1],
    legs: top.filter(f => f[0] === 3).map(([, b]) => {
      const leg = fields(b);
      const place = f => { const p = fields(f[1]); return text(p.find(x => x[0] === 2)[1]); };
      return {
        date: text(leg.find(f => f[0] === 2)[1]),
        from: leg.filter(f => f[0] === 13).map(place),
        to: leg.filter(f => f[0] === 14).map(place),
        maxStops: leg.find(f => f[0] === 5)?.[1] ?? null,
      };
    }),
  };
}

// The ds:1 payload of the captured page; its flights are in [3][0].
const capturedPayload = (() => {
  const at = capturedPage.indexOf("key: 'ds:1'");
  const start = capturedPage.indexOf('data:', at) + 5;
  return JSON.parse(capturedPage.slice(start, capturedPage.indexOf(', sideChannel', start)));
})();

const page = payload => `<!doctype html><html><body><script nonce="x">AF_initDataCallback({key: 'ds:0', hash: '1', data:[[null,null,0,"x"]], sideChannel: {}});</script>`
  + `<script nonce="x">AF_initDataCallback({key: 'ds:1', hash: '9', data:${JSON.stringify(payload)}, sideChannel: {}});</script></body></html>`;

// A results page for any search: the captured itineraries relabelled with the searched
// airports/dates and prices that rank predictably. Italy < Germany; "More Italy" and the
// Portugal group are cheaper still; earlier dates are cheaper; flying from CLT saves $20;
// from a US hub the transatlantic fare is $300 less and the domestic hop costs $90; before
// Dec 10 everything is $400 cheaper.
const GROUP_BASE = { FRA: 900, FCO: 700, LIS: 650, NUE: 950, LIN: 640, OPO: 610, LHR: 800, VIE: 820 };
function fakePage(url) {
  const { trip, legs } = decodeSearch(url);
  const { date, from, to } = legs[0];
  const domestic = from.every(a => US.has(a)) && to.every(a => US.has(a));
  const outbound = US.has(from[0]);
  const europe = outbound ? to : from;
  const fromHub = US_HUBS.includes(from[0]) || US_HUBS.includes(to[0]) && !domestic;
  let base = domestic ? 90 : (GROUP_BASE[europe[0]] ?? 760) + (Number(date.slice(8)) - 12) * 10 - (fromHub ? 300 : 0);
  if (date < '2026-12-10') base -= 400; // early December is much cheaper
  if (trip === 2) base = Math.round(base * 0.6);
  const payload = structuredClone(capturedPayload);
  payload[3][0] = payload[3][0].slice(0, 3).map((entry, i) => {
    const e = structuredClone(entry);
    const o = from[i % from.length];
    const t = to[(2 * i) % to.length];
    e[0][3] = o;
    e[0][6] = t;
    e[0][4] = date.split('-').map(Number);
    e[0][7] = date.split('-').map(Number);
    e[0][5] = domestic ? [7, 0] : [18, 0]; // depart
    e[0][8] = domestic ? [9, 30] : [23, 0]; // arrive
    e[0][2][0][3] = o;
    e[0][2][e[0][2].length - 1][6] = t;
    const home = outbound ? o : t;
    e[1][0][1] = base + i * 15 + (home === 'CLT' ? 0 : 20);
    return e;
  });
  payload[6] = [[['2026-12-09', trip === 1 ? '2026-12-19' : null, [[null, base - 100], 'tok']]]];
  return { status: 200, url, body: page(payload) };
}

function makeSandbox({ config = {}, storage = new Map(), respond = fakePage, host = 'www.google.com' } = {}) {
  const calls = [];
  const logs = [];
  const downloads = [];
  async function fetch(url, init = {}) {
    calls.push(url);
    assert.ok(url.startsWith('https://www.google.com/travel/flights/search?tfs='), url);
    assert.equal(init.credentials, 'include');
    const out = respond(url, calls.length);
    return { status: out.status, ok: out.status < 400, url: out.url || url, text: async () => out.body };
  }
  const record = (...args) => logs.push(args.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const context = {
    console: { log: record, warn: record, error: record, table: record },
    fetch,
    location: { hostname: host },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: { createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }), body: { appendChild() {} } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob, TextEncoder, btoa, Intl,
    setTimeout: fn => setImmediate(fn),
    GF_FARE_CONFIG: { delayMs: [0, 0], ...config },
  };
  context.window = context;
  vm.createContext(context);
  return { context, calls, logs, downloads, run: () => vm.runInContext(script, context) };
}

const oneDay = { departDates: ['2026-12-14', '2026-12-14'], returnDates: ['2026-12-22', '2026-12-22'] };

test('builds the captured search URL and reads the captured results page', async () => {
  const sb = makeSandbox({
    config: {
      ...GRID_ONLY, homeAirports: ['CHS', 'GSP', 'CLT', 'CAE'], destinations: { Madrid: ['/m/056_y'] }, visitCountries: ['Madrid'],
      departDates: ['2026-12-17', '2026-12-17'], returnDates: ['2026-12-27', '2026-12-27'], searchOneWays: false,
    },
    respond: url => ({ status: 200, body: capturedPage, url }),
  });
  await sb.run();
  assert.equal(sb.calls.length, 1);
  // Same search as the captured URL. (The capture also carries leg field 12 = 900, a
  // duration filter the user had set, which the script doesn't use.)
  const mine = decodeSearch(sb.calls[0]);
  assert.deepEqual(mine, decodeSearch(capturedUrl));
  assert.deepEqual(mine.legs[0], { date: '2026-12-17', from: ['CHS', 'GSP', 'CLT', 'CAE'], to: ['/m/056_y'], maxStops: null });
  const capturedWithoutDuration = Buffer.from(new URL(capturedUrl).searchParams.get('tfs').replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    .toString('latin1').replace(/`\x84\x07/g, '').replace(/\x1aA/g, '\x1a>');
  const mineBytes = Buffer.from(new URL(sb.calls[0]).searchParams.get('tfs').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  assert.equal(mineBytes, capturedWithoutDuration);

  const { rows, trips, bestPerRoute, hints } = plain(sb.context.googleFares);
  assert.deepEqual(rows.map(r => [r.price, r.from, r.to, r.flights, r.stops]), [
    [1304, 'GSP', 'MAD', 'AA5177 AA740', 1],
    [1376, 'CLT', 'MAD', 'AA748', 0],
    [1469, 'CHS', 'MAD', 'AA5563 AA748', 1],
    [1482, 'CLT', 'MAD', 'AA1960 AA740', 1],
  ]);
  assert.deepEqual([rows[0].depart, rows[0].arrive, rows[0].airlines, rows[0].layovers], ['2026-12-17 16:02', '2026-12-18 08:55', 'American', 'PHL 1h45']);
  // GSP is cheapest even with its 10-night drive + parking.
  assert.equal(bestPerRoute[0].route, 'GSP ⇄ MAD');
  assert.equal(trips[0].hops, 0);
  assert.equal(trips[0].driveAndPark, ground('GSP', 10));
  assert.equal(trips[0].total, 1304 + ground('GSP', 10));
  assert.deepEqual(decodeSearch(trips[0].link).legs.map(l => [l.date, l.from, l.to]), [['2026-12-17', ['GSP'], ['MAD']], ['2026-12-27', ['/m/056_y'], ['GSP']]]);
  // Google's cheaper-dates hint (Dec 15–25 for $869) is outside the searched dates, so it's reported.
  assert.deepEqual(hints[0], { kind: 'RT', group: 'Madrid', out: '2026-12-15', ret: '2026-12-25', price: 869 });
  assert.ok(sb.logs.some(l => l.includes('Google suggested cheaper dates')));
});

test('default plan: grid, more places, each home airport, US hubs, one-ways, other weeks', async () => {
  const sb = makeSandbox();
  await sb.run();
  const { trips, bestPerRoute, csv, rows, multiCity, otherDates } = plain(sb.context.googleFares);
  const searches = sb.calls.map(decodeSearch);
  const pairs = 5 * 4; // Dec 12–16 × Dec 21–24
  const legs0 = s => [s.legs[0].from.join(','), s.legs[0].to.join(','), s.legs[0].date];

  // 1. Date grid: 3 groups per pair, all home airports together.
  const grid = searches.slice(0, pairs * 3);
  assert.ok(grid.every(s => s.trip === 1 && s.legs[0].from.join() === HOMES.join()));
  // 2. More places: 5 groups on the 3 cheapest date pairs.
  const more = searches.slice(pairs * 3, pairs * 3 + 15);
  assert.deepEqual([...new Set(more.map(s => s.legs[0].to[0]))].sort(), ['LHR', 'LIN', 'NUE', 'OPO', 'VIE']);
  // …on 3 date pairs. (The cheapest totals are the shortest trips here: parking costs more
  // per day than the fake fares rise per day.)
  assert.equal(new Set(more.map(s => `${s.legs[0].date}|${s.legs[1].date}`)).size, 3);
  // 3. Each home airport alone for the two cheapest groups (Portugal… and More Italy).
  const each = searches.slice(pairs * 3 + 15, pairs * 3 + 15 + 20);
  assert.deepEqual(each.map(s => s.legs[0].from.join()), [...EACH_HOME, ...EACH_HOME]);
  assert.deepEqual([...new Set(each.map(s => s.legs[0].to[0]))].sort(), ['LIN', 'OPO']);
  assert.ok(each.every(s => s.legs[1].to.length === 1 && s.legs[1].to[0] === s.legs[0].from[0]), 'come home to the same airport');
  // 4. US hubs: transatlantic from the 7 hubs, then home ⇄ the two cheapest hubs found.
  const hubs = searches.filter(s => s.legs[0].from.join() === US_HUBS.join());
  assert.equal(hubs.length, 2);
  const positioning = searches.filter(s => s.legs[0].from.join() === HOMES.join() && s.legs[0].to.length === 1 && US_HUBS.includes(s.legs[0].to[0]));
  // Two cheapest hubs per hub search, shared when both groups' best dates are the same.
  assert.equal(positioning.length, 2 * new Set(hubs.map(s => `${s.legs[0].date}|${s.legs[1].date}`)).size);
  // 5. One-ways and 6. other weeks.
  assert.equal(searches.filter(s => s.trip === 2).length, (5 + 4) * 3);
  const shifted = searches.filter(s => s.legs[0].date < '2026-12-12' || s.legs[0].date > '2026-12-16').filter(s => s.trip === 1);
  assert.equal(shifted.length, 2 * 4);
  assert.equal(sb.calls.length, 60 + 15 + 20 + 2 + positioning.length + 27 + 8);

  // Every total = airfare + drive & parking for the home airport + hops.
  for (const t of trips) {
    assert.equal(t.nights, (Date.parse(t.ret) - Date.parse(t.out)) / 864e5);
    const g = t.home2 ? (ground(t.home, t.nights) + ground(t.home2, t.nights)) / 2 : ground(t.home, t.nights);
    assert.equal(t.driveAndPark, g, t.route);
    assert.equal(t.total, t.airfare + g + t.hops * 75, t.route);
  }
  assert.equal(trips.find(t => t.strategy === 'Round trip' && t.to === 'FCO').hops, 2);
  assert.equal(trips.find(t => t.strategy === 'Round trip' && t.to === 'LIN').hops, 2, '"More Italy" counts as Italy');
  assert.equal(trips.find(t => t.strategy === 'Round trip' && t.to === 'OPO').hops, 3);

  // US hub: $90 domestic + transatlantic $300 cheaper, with an 8.5h gap at the hub.
  const hub = trips.find(t => t.strategy === 'Via US hub (2 tickets)');
  assert.ok(hub);
  assert.match(hub.route, /^\w{3} → (JFK|EWR|BOS|IAD|PHL|MCO|MIA) → \w{3}$/);
  assert.match(hub.times, /8h at/);
  assert.equal(decodeSearch(hub.link).legs[0].to.length, 1);
  assert.ok(sb.logs.some(l => l.includes('Two tickets through a US hub')));

  // Each home airport: AGS (75 mi, $10/day) can beat the airports further away.
  assert.ok(sb.logs.some(l => l.includes('Best round trip from each home airport')));
  assert.ok(trips.some(t => t.from === 'SAV' && t.strategy === 'Round trip'));

  // Other weeks: a week or two earlier lands in early December (much cheaper in the fake) and beats your best.
  assert.ok(otherDates.length > 0 && otherDates.every(t => !t.yourDates && t.total < bestPerRoute[0].total));
  assert.ok(bestPerRoute.every(t => t.yourDates));
  assert.ok(bestPerRoute.every((t, i) => i === 0 || bestPerRoute[i - 1].total <= t.total));

  // Multi-city links sorted by their one-way score.
  assert.ok(multiCity.length >= 4);
  assert.ok(multiCity.every((m, i) => i === 0 || multiCity[i - 1].score <= m.score));
  assert.equal(decodeSearch(multiCity[0].link).trip, 3);

  assert.ok(rows.every(r => r.price > 0));
  assert.ok(csv.startsWith('strategy,route,group,from,to,from2,to2,out,ret,nights,airlines,stops,flights,times,layovers,airfare,driveAndPark,hops,total,yourDates,link,link2\n'));
  assert.equal(sb.downloads.length, 2);
  assert.ok(sb.logs.some(l => l.startsWith('Drive + parking for a 9-night trip: CAE $122')));
});

test('hub combinations need time to connect', async () => {
  // Domestic flights that land after the transatlantic one leaves are dropped.
  const late = url => {
    const out = fakePage(url);
    return { ...out, body: out.body.replace(/\[9,30\]/g, '[19,30]') };
  };
  const sb = makeSandbox({ config: { ...oneDay, morePlaces: {}, eachHomeAirport: [], otherWeeks: [], searchOneWays: false }, respond: late });
  await sb.run();
  const { trips } = plain(sb.context.googleFares);
  assert.ok(!trips.some(t => t.strategy === 'Via US hub (2 tickets)'));
  assert.ok(sb.logs.some(l => l.includes('No US-hub combination left at least 3h')));
});

test('one-way return hints are checked against the return dates', async () => {
  const sb = makeSandbox({ config: { ...GRID_ONLY, ...oneDay, returnDates: ['2026-12-09', '2026-12-09'], departDates: ['2026-12-01', '2026-12-01'] } });
  await sb.run();
  const table = sb.logs.find(l => l.includes('"search":"one-way'));
  // Hints on Dec 9 are inside returnDates, so the one-way return ones aren't reported.
  assert.ok(!table || !table.includes('→ home","date":"2026-12-09"'));
});

test('maxStops and passengers go into the search', async () => {
  const sb = makeSandbox({ config: { ...GRID_ONLY, ...oneDay, maxStops: 0, adults: 2, searchOneWays: false } });
  await sb.run();
  const s = decodeSearch(sb.calls[0]);
  assert.equal(s.adults, 2);
  assert.deepEqual(s.legs.map(l => l.maxStops), [0, 0]);
});

test('cache makes a second run free; stop flag halts after the current search', async () => {
  const storage = new Map();
  const first = makeSandbox({ storage, config: oneDay });
  await first.run();
  const second = makeSandbox({ storage, config: oneDay });
  await second.run();
  assert.equal(second.calls.length, 0);
  assert.equal(plain(second.context.googleFares.bestPerRoute)[0].route, plain(first.context.googleFares.bestPerRoute)[0].route);

  const stopped = makeSandbox({ config: oneDay });
  stopped.context.GF_FARE_STOP = true; // left over from an earlier run: cleared at start
  const realFetch = stopped.context.fetch;
  stopped.context.fetch = (...args) => {
    stopped.context.GF_FARE_STOP = true;
    return realFetch(...args);
  };
  await stopped.run();
  assert.equal(stopped.calls.length, 1);
  assert.ok(stopped.logs.some(l => l.includes('Stopped early')));
  assert.ok(plain(stopped.context.googleFares.trips).length > 0);
});

test('robot check halts; pages without data are retried, then stop the run after three searches', async () => {
  const sorry = makeSandbox({ config: oneDay, respond: () => ({ status: 200, url: 'https://www.google.com/sorry/index?continue=x', body: '<html>unusual traffic</html>' }) });
  await sorry.run();
  assert.equal(sorry.calls.length, 1);
  assert.ok(sorry.logs.some(l => l.includes('not a robot')));

  const limited = makeSandbox({ config: oneDay, respond: () => ({ status: 429, body: '' }) });
  await limited.run();
  assert.equal(limited.calls.length, 1);

  // First search: two pages without ds:1, then a good one. Second search: never has data.
  const storage = new Map();
  let n = 0;
  const flaky = makeSandbox({
    storage,
    config: { ...GRID_ONLY, ...oneDay, destinations: { Germany: ['FRA'], Italy: ['FCO'] }, searchOneWays: false },
    respond: url => (++n <= 2 || n >= 4 ? { status: 200, body: '<html>no data</html>' } : fakePage(url)),
  });
  await flaky.run();
  assert.equal(flaky.calls.length, 3 + 3);
  assert.ok(flaky.logs.some(l => l.includes('no fares (HTTP 200, no results on the page)')));
  assert.equal(Object.keys(JSON.parse(storage.get('gfFareFinder.v2'))).length, 1);

  // Every page empty: three searches (3 fetches each), then a clear stop instead of 87 more.
  const blocked = makeSandbox({ config: oneDay, respond: () => ({ status: 200, body: '<html>consent</html>' }) });
  await blocked.run();
  assert.equal(blocked.calls.length, 9);
  assert.ok(blocked.logs.some(l => l.includes('without flight data 3 times in a row')));
  assert.ok(blocked.logs.some(l => l.includes('Nothing to rank')));

  const down = makeSandbox({ config: { ...oneDay, searchOneWays: false }, respond: () => ({ status: 503, body: '' }) });
  await down.run();
  assert.equal(down.calls.length, 3);
  assert.ok(down.logs.some(l => l.includes('HTTP 503 after 3 tries')));
});

test('refuses to run off www.google.com and when over maxRequests', async () => {
  for (const host of ['www.delta.com', 'www.google.co.uk']) {
    const off = makeSandbox({ host });
    await off.run();
    assert.equal(off.calls.length, 0, host);
  }
  const big = makeSandbox({ config: { departDates: ['2026-12-01', '2026-12-31'], returnDates: ['2027-01-01', '2027-01-20'], maxNights: 60 } });
  await big.run();
  assert.equal(big.calls.length, 0);
  assert.ok(big.logs.some(l => l.includes('more than maxRequests')));
});
