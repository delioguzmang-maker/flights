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

const HOMES = ['CHS', 'CAE', 'GSP', 'CLT'];

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
// airports/dates and prices that rank predictably (Italy < Germany, earlier dates cheaper).
const GROUP_BASE = { Germany: 900, Italy: 700, 'Other hubs': 650 };
const groupOf = airports => (airports.includes('FRA') ? 'Germany' : airports.includes('FCO') ? 'Italy' : 'Other hubs');
function fakePage(url) {
  const { trip, legs } = decodeSearch(url);
  const { date, from, to } = legs[0];
  const homeSide = HOMES.includes(from[0]);
  const group = groupOf(homeSide ? to : from);
  let base = GROUP_BASE[group] + (Number(date.slice(8)) - 12) * 10;
  if (trip === 2) base = Math.round(base * 0.6);
  const payload = structuredClone(capturedPayload);
  payload[3][0] = payload[3][0].slice(0, 3).map((entry, i) => {
    const e = structuredClone(entry);
    const o = from[i % from.length];
    const t = to[(2 * i) % to.length];
    e[0][3] = o;
    e[0][6] = t;
    e[0][4] = date.split('-').map(Number);
    e[0][2][0][3] = o;
    e[0][2][e[0][2].length - 1][6] = t;
    e[1][0][1] = base + i * 15 + ((homeSide ? o : t) === 'CLT' ? 0 : 20);
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
      homeAirports: ['CHS', 'GSP', 'CLT', 'CAE'], destinations: { Madrid: ['/m/056_y'] }, visitCountries: ['Madrid'],
      departDates: ['2026-12-17', '2026-12-17'], returnDates: ['2026-12-27', '2026-12-27'], searchOneWays: false,
    },
    respond: url => ({ status: 200, body: capturedPage, url }),
  });
  await sb.run();
  assert.equal(sb.calls.length, 1);
  // Same search as the captured URL. (The capture also carries leg field 12 = 900, a
  // duration filter the user had set, which the script doesn't use.)
  const mine = decodeSearch(sb.calls[0]);
  const captured = decodeSearch(capturedUrl);
  assert.deepEqual(mine, captured);
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
  assert.equal(bestPerRoute[0].route, 'GSP ⇄ MAD');
  assert.equal(trips[0].hops, 0);
  assert.deepEqual(decodeSearch(trips[0].link).legs.map(l => [l.date, l.from, l.to]), [['2026-12-17', ['GSP'], ['MAD']], ['2026-12-27', ['MAD'], ['GSP']]]);
  // Google's cheaper-dates hint (Dec 15–25 for $869) is outside the searched dates, so it's reported.
  assert.deepEqual(hints[0], { kind: 'RT', group: 'Madrid', out: '2026-12-15', ret: '2026-12-25', price: 869 });
  assert.ok(sb.logs.some(l => l.includes('Google suggested cheaper dates')));
});

test('default plan: round trips and one-way pairs ranked by total, multi-city links suggested', async () => {
  const sb = makeSandbox();
  await sb.run();
  const { trips, bestPerRoute, csv, rows, multiCity } = plain(sb.context.googleFares);
  const pairs = 5 * 4; // Dec 12–16 × Dec 21–24
  assert.equal(sb.calls.length, pairs * 3 + (5 + 4) * 3);
  const searches = sb.calls.map(decodeSearch);
  assert.equal(searches.filter(s => s.trip === 1).length, pairs * 3);
  assert.equal(searches.filter(s => s.trip === 2).length, 27);
  assert.ok(searches.every(s => s.adults === 1 && s.seat === 1));
  assert.deepEqual(searches[0].legs.map(l => [l.date, l.from, l.to]), [
    ['2026-12-12', HOMES, ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR', 'CGN']],
    ['2026-12-21', ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR', 'CGN'], HOMES],
  ]);

  for (const t of trips) {
    assert.equal(t.total, t.airfare + t.hops * 75);
    assert.equal(t.nights, (Date.parse(t.ret) - Date.parse(t.out)) / 864e5);
  }
  assert.equal(trips.find(t => t.strategy === 'Round trip' && t.to === 'FCO').hops, 2);
  assert.equal(trips.find(t => t.strategy === 'Round trip' && t.to === 'MAD').hops, 3);
  const ow = trips.filter(t => t.strategy === 'Two one-ways');
  assert.ok(ow.length > 0 && ow.every(t => t.from === t.to2));
  assert.equal(ow.find(t => t.to === 'FRA' && t.from2 === 'FCO').hops, 1);
  // Cheapest: one-way out to Germany is 0.6 × 900 = 540 (+20 from CHS) and back from Italy
  // 0.6 × (700 + 90) = 474 (+20): 1054 + 1 hop, vs round trip Italy 720 + 2 hops = 870.
  assert.deepEqual([trips[0].strategy, trips[0].route, trips[0].out, trips[0].total], ['Round trip', 'CHS ⇄ FCO', '2026-12-12', 720 + 150]);
  assert.ok(bestPerRoute.every((t, i) => i === 0 || bestPerRoute[i - 1].total <= t.total));

  // Multi-city links: homes → the cheapest airport of one country … the other → homes.
  assert.ok(multiCity.length >= 4);
  const mc = decodeSearch(multiCity[0].link);
  assert.equal(mc.trip, 3);
  assert.deepEqual(mc.legs[0].from, HOMES);
  assert.deepEqual(mc.legs[1].to, HOMES);
  assert.ok(sb.logs.some(l => l.includes('Multi-city searches worth opening by hand')));

  assert.ok(rows.every(r => r.price > 0));
  assert.ok(csv.startsWith('strategy,route,from,to,from2,to2,out,ret,nights,airlines,stops,flights,times,layovers,airfare,hops,total,link,link2\n'));
  assert.equal(sb.downloads.length, 2);
  assert.ok(sb.logs.some(l => l.includes('Cheapest est. total by departure')));
});

test('maxStops and passengers go into the search', async () => {
  const sb = makeSandbox({ config: { ...oneDay, maxStops: 0, adults: 2, searchOneWays: false } });
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

test('robot check halts politely; a page missing its data is retried, then skipped uncached', async () => {
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
    config: { ...oneDay, destinations: { Germany: ['FRA'], Italy: ['FCO'] }, searchOneWays: false },
    respond: url => (++n <= 2 || n >= 4 ? { status: 200, body: '<html>no data</html>' } : fakePage(url)),
  });
  await flaky.run();
  assert.equal(flaky.calls.length, 3 + 3);
  assert.ok(flaky.logs.some(l => l.includes('no fares (HTTP 200, no results on the page)')));
  assert.equal(Object.keys(JSON.parse(storage.get('gfFareFinder.v2'))).length, 1);

  const down = makeSandbox({ config: { ...oneDay, searchOneWays: false }, respond: () => ({ status: 503, body: '' }) });
  await down.run();
  assert.equal(down.calls.length, 3);
  assert.ok(down.logs.some(l => l.includes('HTTP 503 after 3 tries')));
});

test('refuses to run off google.com and when over maxRequests', async () => {
  const off = makeSandbox({ host: 'www.delta.com' });
  await off.run();
  assert.equal(off.calls.length, 0);
  const big = makeSandbox({ config: { departDates: ['2026-12-01', '2026-12-31'], returnDates: ['2027-01-01', '2027-01-20'], maxNights: 60 } });
  await big.run();
  assert.equal(big.calls.length, 0);
  assert.ok(big.logs.some(l => l.includes('more than maxRequests')));
});
