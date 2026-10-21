/*
 * Google Flights fare finder — DevTools console script
 *
 * Searches every airline Google Flights shows (not just Delta) and ranks the ways of doing
 * the trip by what it really costs you: airfare, plus the drive to the airport and parking
 * (set up for Columbia, SC; edit CONFIG.drive), plus trains/budget flights between the
 * countries you visit. Each result gets a link that opens the exact search on Google
 * Flights so you can book it.
 *
 * What it searches, in order:
 *   1. Round trips from all your home airports at once to Germany, Italy and other cheap
 *      European hubs, for every departure × return date pair in your ranges.
 *   2. More places (more German/Italian airports; Portugal, Spain & France; UK, Ireland &
 *      Iceland; Central Europe) on the cheapest date pairs.
 *   3. Each home airport on its own, including farther ones (Atlanta, Augusta, Savannah…),
 *      because the results page only lists its top few flights.
 *   4. Two separate tickets through a big US hub (New York, Boston, Washington, Orlando,
 *      Miami…): a cheap domestic round trip to the hub plus a transatlantic one from it.
 *   5. One-way tickets each way (budget transatlantic airlines show up here).
 *   6. The cheapest trips moved one or two weeks earlier or later.
 *
 * How it searches: it loads the same results page you'd open in a tab (one per search)
 * and reads the flights embedded in it. Google's internal search API now needs a token
 * only its own page code can make, so the script doesn't call it. Multi-city prices only
 * load through that API, so instead of pricing them the script prints ready-made
 * multi-city links for the most promising combinations, to check by hand.
 *
 * HOW TO RUN
 *   1. Open https://www.google.com/travel/flights (google.com, not a country site like
 *      google.co.uk) in Chrome, Edge or Firefox. Signed in or not both work.
 *   2. Open DevTools (F12, or Cmd+Option+J on a Mac) and pick the Console tab.
 *   3. Change CONFIG below if you want, paste this whole file and press Enter.
 *      The browser may first ask you to type "allow pasting".
 *   4. Leave the tab open. Progress prints as it goes (the default plan is ~140 searches,
 *      about 15 minutes). Results print as tables and download as CSV + JSON.
 *
 * Stop early:  window.GF_FARE_STOP = true   (the results so far are still ranked)
 * Re-running is cheap: searches from the last few hours are reused from localStorage.
 * Override settings without editing:  window.GF_FARE_CONFIG = { hopCost: 60 }  then paste.
 */
(async () => {
  'use strict';

  const CONFIG = {
    // Searched together in the date-grid searches (Google allows up to 7 airports per side).
    homeAirports: ['CAE', 'CLT', 'GSP', 'CHS'],
    // Searched one at a time on the cheapest dates, so each gets its own price.
    eachHomeAirport: ['CAE', 'CLT', 'GSP', 'CHS', 'AGS', 'SAV', 'ATL', 'MYR', 'AVL', 'RDU'],

    // Getting to the airport. Every trip's est. total adds gas for the drive there and back
    // plus parking for each day you're away (nights + 1). Miles are one way from Columbia,
    // SC; parking is each airport's cheapest on-airport long-term lot (airport websites,
    // Oct 2026). Edit for where you live. dropOff: true = someone drives you (gas for two
    // round trips, no parking).
    drive: {
      gasPerGallon: 3.00,
      milesPerGallon: 28,
      dropOff: false,
      airports: {
        CAE: { miles: 10, parkingPerDay: 12 },
        CLT: { miles: 95, parkingPerDay: 14 },
        GSP: { miles: 95, parkingPerDay: 10 },
        CHS: { miles: 115, parkingPerDay: 13 },
        AGS: { miles: 75, parkingPerDay: 10 },
        SAV: { miles: 160, parkingPerDay: 7 },
        ATL: { miles: 215, parkingPerDay: 14 },
        MYR: { miles: 150, parkingPerDay: 12 },
        AVL: { miles: 160, parkingPerDay: 12 },
        RDU: { miles: 225, parkingPerDay: 10 },
      },
    },
    // Anything else an airport costs you per trip, e.g. { ATL: 120 } for a hotel the night before.
    homeAirportExtraCost: {},

    // Destination groups searched for every date pair, up to 7 airports each.
    destinations: {
      Germany: ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR', 'CGN'],
      Italy: ['FCO', 'MXP', 'VCE', 'NAP', 'BLQ', 'FLR', 'PSA'],
      'Other hubs': ['LIS', 'MAD', 'BCN', 'AMS', 'CDG', 'DUB', 'ZRH'],
    },
    // More groups, searched on the cheapest date pairs only.
    morePlaces: {
      'More Germany': ['NUE', 'LEJ', 'HAJ', 'BRE', 'DRS', 'FMO', 'DTM'],
      'More Italy': ['LIN', 'BGY', 'TRN', 'VRN', 'BRI', 'CTA', 'PMO'],
      'Portugal, Spain & France': ['OPO', 'FAO', 'AGP', 'VLC', 'ORY', 'NCE', 'LYS'],
      'UK, Ireland & Iceland': ['LHR', 'LGW', 'MAN', 'EDI', 'SNN', 'ORK', 'KEF'],
      'Central Europe': ['VIE', 'PRG', 'BUD', 'WAW', 'KRK', 'CPH', 'BRU'],
    },
    // Countries you must see. A group whose name contains one of them (e.g. "More Italy")
    // counts as that country; any other group is one more place to travel through.
    visitCountries: ['Germany', 'Italy'],
    // Your estimate (per person) for one train / budget-airline hop between countries.
    hopCost: 75,

    // Date ranges, inclusive; every departure × return pair inside the nights limits is searched.
    departDates: ['2026-12-12', '2026-12-16'],
    returnDates: ['2026-12-21', '2026-12-24'],
    minNights: 1,
    maxNights: 30,
    // How many of the cheapest date pairs the extra searches (steps 2–4, 6) use.
    bestDatePairs: 3,

    // Separate tickets through a big US hub. Leave plenty of time between the two flights:
    // if the first one is late, the second airline doesn't have to rebook you.
    usHubs: ['JFK', 'EWR', 'BOS', 'IAD', 'PHL', 'MCO', 'MIA'],
    hubConnectionHours: 3, // minimum gap between landing at the hub and the transatlantic flight
    // Move the two cheapest trips by these many days.
    otherWeeks: [-14, -7, 7, 14],

    adults: 1,
    seat: 1, // 1 economy, 2 premium economy, 3 business, 4 first
    maxStops: null, // null any, 0 nonstop only, 1 one stop or fewer, 2 two stops or fewer

    searchOneWays: true, // separate one-way tickets
    mixHomeAirports: false, // let one-way pairs leave from one home airport and return to another
    multiCityLinks: 5, // how many multi-city searches to suggest checking by hand

    currency: 'USD',
    language: 'en-US',
    country: 'US',
    delayMs: [3000, 6000], // pause between searches; Google starts refusing if you go too fast
    maxRequests: 300,
    cacheHours: 6,
    showTop: 25,
    download: true,
  };
  // Settings in window.GF_FARE_CONFIG win. drive is merged, so { drive: { dropOff: true } }
  // keeps the airport table; drive: false turns drive and parking costs off.
  const overrides = window.GF_FARE_CONFIG || {};
  const defaultDrive = CONFIG.drive;
  Object.assign(CONFIG, overrides);
  if (overrides.drive === false || overrides.drive === null) CONFIG.drive = { airports: {} };
  else if (overrides.drive) CONFIG.drive = { ...defaultDrive, ...overrides.drive, airports: { ...defaultDrive.airports, ...(overrides.drive.airports || {}) } };

  const CACHE_KEY = 'gfFareFinder.v2';
  const TRIP = { roundTrip: 1, oneWay: 2, multiCity: 3 };

  // The script fetches https://www.google.com pages, which the browser only allows from a google.com tab.
  if (location.hostname !== 'www.google.com') {
    console.error('Run this from https://www.google.com/travel/flights (google.com, not a country site like google.co.uk).');
    return;
  }

  // ---------- dates ----------
  const DAY = 864e5;
  const parseDay = s => Date.parse(`${s}T00:00:00Z`);
  const isoDay = t => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => isoDay(parseDay(s) + n * DAY);
  const nightsBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / DAY);
  const inRange = (d, [from, to]) => d >= from && d <= to;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const daysIn = ([from, to]) => {
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    return days;
  };
  const departDays = daysIn(CONFIG.departDates);
  const returnDays = daysIn(CONFIG.returnDates);
  const nightsOk = (o, r) => nightsBetween(o, r) >= CONFIG.minNights && nightsBetween(o, r) <= CONFIG.maxNights;
  const yourDates = (o, r) => inRange(o, CONFIG.departDates) && r != null && inRange(r, CONFIG.returnDates);
  const datePairs = departDays.flatMap(o => returnDays.filter(r => nightsOk(o, r)).map(r => [o, r]));

  const money = n => (n == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: CONFIG.currency, maximumFractionDigits: 0 }).format(n));

  // ---------- places ----------
  const homes = CONFIG.homeAirports;
  const eachHome = CONFIG.eachHomeAirport || [];
  const groups = Object.entries(CONFIG.destinations).map(([name, airports]) => ({ name, airports, main: true }))
    .concat(Object.entries(CONFIG.morePlaces || {}).map(([name, airports]) => ({ name, airports, main: false })));
  const groupByName = Object.fromEntries(groups.map(g => [g.name, g]));
  const tripCountries = CONFIG.visitCountries.filter(c => groups.some(g => g.name.includes(c)));
  // The place a group counts as for hops: the visit country in its name, or itself.
  const placeOf = name => tripCountries.find(c => name.includes(c)) || name;
  const visitGroups = groups.filter(g => g.main && tripCountries.includes(placeOf(g.name)));
  for (const list of [homes, CONFIG.usHubs || [], ...groups.map(g => g.airports)]) {
    if (list.length > 7) console.warn(`More than 7 airports in one field (${list.join(', ')}); Google may ignore some.`);
  }
  const noDriveData = [...new Set([...homes, ...eachHome])].filter(a => !(CONFIG.drive?.airports || {})[a]);
  if (noDriveData.length) console.warn(`No drive/parking figures for ${noDriveData.join(', ')}; their trips are ranked without that cost.`);

  // Gas to the airport and back plus parking for every day away (or gas for two round trips
  // when someone drops you off), plus anything in homeAirportExtraCost.
  function groundCost(airport, nights) {
    const d = CONFIG.drive || {};
    const a = (d.airports || {})[airport];
    const extra = (CONFIG.homeAirportExtraCost || {})[airport] || 0;
    if (!a) return extra;
    const gasPerMile = (d.gasPerGallon || 0) / (d.milesPerGallon || 25);
    const drive = d.dropOff ? 4 * a.miles * gasPerMile : 2 * a.miles * gasPerMile + (a.parkingPerDay || 0) * (nights + 1);
    return Math.round(drive + extra);
  }

  // ---------- search links ----------
  // Google Flights addresses a search with tfs=, a small protobuf: trip type, passengers,
  // cabin and per-leg date + airports. Verified byte-for-byte against a captured search URL.
  function searchUrl(trip, legs) {
    const varint = n => {
      const out = [];
      while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
      out.push(n);
      return out;
    };
    const num = (no, n) => [...varint(no * 8), ...varint(n)];
    const bytes = (no, b) => [...varint(no * 8 + 2), ...varint(b.length), ...b];
    const str = (no, s) => bytes(no, [...new TextEncoder().encode(s)]);
    // Airports are type 1; Knowledge Graph places like "/m/056_y" (Madrid) are type 2.
    const place = p => [...num(1, p.startsWith('/') ? 2 : 1), ...str(2, p)];
    const out = [...num(1, 28), ...num(2, 2)];
    for (const leg of legs) {
      const body = [...str(2, leg.date)];
      if (CONFIG.maxStops != null) body.push(...num(5, CONFIG.maxStops));
      for (const p of leg.from) body.push(...bytes(13, place(p)));
      for (const p of leg.to) body.push(...bytes(14, place(p)));
      out.push(...bytes(3, body));
    }
    for (let i = 0; i < CONFIG.adults; i++) out.push(...num(8, 1));
    out.push(...num(9, CONFIG.seat), ...num(14, 1));
    out.push(...bytes(16, [0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])); // no price limit
    out.push(...num(19, trip));
    const tfs = btoa(String.fromCharCode(...out)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `https://www.google.com/travel/flights/search?tfs=${tfs}&hl=${CONFIG.language}&gl=${CONFIG.country}&curr=${CONFIG.currency}`;
  }

  // ---------- fetching ----------
  class Halt extends Error {}

  // The results page embeds its flights in
  // <script>AF_initDataCallback({key: 'ds:1', hash: '…', data: […], sideChannel: {}});</script>.
  // Read up to the last ", sideChannel" before that script ends, so text inside the data
  // can't cut it short.
  function pagePayload(html) {
    const at = html.indexOf("key: 'ds:1'");
    if (at < 0) return null;
    const start = html.indexOf('data:', at);
    const scriptEnd = html.indexOf('</script>', at);
    const end = html.lastIndexOf(', sideChannel', scriptEnd < 0 ? html.length : scriptEnd);
    if (start < 0 || end < start) return null;
    try {
      return JSON.parse(html.slice(start + 5, end));
    } catch {
      return null;
    }
  }

  async function fetchPage(url) {
    for (let attempt = 0; ; attempt++) {
      let res;
      let html;
      try {
        res = await fetch(url, { credentials: 'include' });
        html = await res.text();
      } catch (e) {
        if (attempt >= 2) throw new Halt(`network error (${e.message})`);
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (res.status === 429 || /\/sorry\//.test(res.url || '') || /unusual traffic/i.test(html.slice(0, 5000))) {
        throw new Halt('Google wants to check you\'re not a robot. Open Google Flights in this tab, do one normal search (solve the check if shown), wait a few minutes, then paste again; finished searches are cached');
      }
      if (res.status >= 500) {
        if (attempt >= 2) throw new Halt(`HTTP ${res.status} after ${attempt + 1} tries`);
        await sleep(15000 * (attempt + 1));
        continue;
      }
      const payload = pagePayload(html);
      // About one page in sixty arrives without its data block; the same page loads fine a moment later.
      if (!payload && res.ok && attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return { status: res.status, payload };
    }
  }

  // ---------- parsing ----------
  const pad = n => String(n ?? 0).padStart(2, '0');
  const fmtDate = d => (Array.isArray(d) ? `${d[0]}-${pad(d[1])}-${pad(d[2])}` : '');
  const fmtTime = t => (Array.isArray(t) ? `${pad(t[0])}:${pad(t[1])}` : '');

  // One itinerary row. On a round-trip page this is the outbound flight and its price is the
  // cheapest round trip starting with it.
  function parseItinerary(entry) {
    const d = entry?.[0];
    const price = entry?.[1]?.[0]?.[1];
    if (!Array.isArray(d) || typeof price !== 'number') return null;
    const flights = (d[2] || []).map(l => (Array.isArray(l[22]) ? `${l[22][0]}${l[22][1]}` : ''));
    return {
      price,
      airlines: (d[1] || []).join(', '),
      from: d[3],
      to: d[6],
      depart: `${fmtDate(d[4])} ${fmtTime(d[5])}`,
      arrive: `${fmtDate(d[7])} ${fmtTime(d[8])}`,
      minutes: d[9],
      stops: Math.max(0, flights.length - 1),
      layovers: (d[13] || []).map(x => `${x[1]} ${Math.floor(x[0] / 60)}h${pad(x[0] % 60)}`).join(', '),
      flights: flights.join(' '),
    };
  }

  function parsePayload(p) {
    const byKey = new Map();
    for (const block of [p?.[2], p?.[3]]) {
      for (const entry of block?.[0] || []) {
        const it = parseItinerary(entry);
        if (!it) continue;
        const key = `${it.flights}|${it.depart}`;
        if (!byKey.has(key) || byKey.get(key).price > it.price) byKey.set(key, it);
      }
    }
    // Google's own "cheaper dates" suggestion: [[departDate, returnDate, [[null, price], token], …], …]
    const hints = [];
    for (const h of p?.[6]?.[0] || []) {
      if (typeof h?.[0] === 'string' && typeof h?.[2]?.[0]?.[1] === 'number') {
        hints.push({ out: h[0], ret: typeof h[1] === 'string' ? h[1] : null, price: h[2][0][1] });
      }
    }
    return { itineraries: [...byKey.values()].sort((a, b) => a.price - b.price), hints };
  }

  // ---------- cache ----------
  const cache = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      const cutoff = Date.now() - CONFIG.cacheHours * 36e5;
      for (const key of Object.keys(saved)) if (!(saved[key].t > cutoff)) delete saved[key];
      return saved;
    } catch {
      return {};
    }
  })();
  const saveCache = () => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      // Storage full or blocked: carry on without caching.
    }
  };

  let requests = 0;
  let emptyInARow = 0;
  async function search(trip, legs) {
    const url = searchUrl(trip, legs);
    if (cache[url]) return { ...cache[url], cached: true };
    if (window.GF_FARE_STOP) throw new Halt('stopped by GF_FARE_STOP');
    if (requests >= CONFIG.maxRequests) throw new Halt(`reached maxRequests (${CONFIG.maxRequests})`);
    if (requests > 0) await sleep(CONFIG.delayMs[0] + Math.random() * (CONFIG.delayMs[1] - CONFIG.delayMs[0]));
    requests++;
    const { status, payload } = await fetchPage(url);
    if (!payload) {
      // Not cached: it may load next time. Three in a row means something's wrong, not one bad page.
      if (++emptyInARow >= 3) {
        throw new Halt(`Google's results pages came back without flight data ${emptyInARow} times in a row (HTTP ${status}). `
          + 'Google may be blocking automated searches, showing a consent page, or have changed the page. Open a normal search in this tab, then try again later');
      }
      return { itineraries: [], hints: [], error: `HTTP ${status}, no results on the page` };
    }
    emptyInARow = 0;
    const entry = { t: Date.now(), ...parsePayload(payload) };
    if (!entry.itineraries.length) entry.error = 'no flights found';
    cache[url] = entry;
    saveCache();
    return entry;
  }

  // ---------- running searches ----------
  const rows = [];
  const hints = [];
  const pairLabel = (o, r) => `${o} → ${r}`;

  async function runTasks(name, tasks) {
    if (!tasks.length) return;
    console.log(`%c${name}: ${tasks.length} searches`, 'font-weight:bold');
    for (const [n, task] of tasks.entries()) {
      const result = await search(task.trip, task.legs);
      // Searches with all your home airports on the home side (not one airport, not a US hub).
      const fromHomes = [task.legs[0].from, task.legs[task.legs.length - 1].to].some(list => list.join() === homes.join());
      const added = result.itineraries.map(it => ({ kind: task.kind, group: task.group, out: task.out, ret: task.ret ?? null, fromHomes, ...task.extra, ...it }));
      rows.push(...added);
      // Date hints only from those searches between home and Europe.
      if (fromHomes && ['RT', 'OW-out', 'OW-back'].includes(task.kind)) for (const h of result.hints) hints.push({ kind: task.kind, group: task.group, ...h });
      task.rows = added;
      const best = result.itineraries[0];
      console.log(`[${name} ${n + 1}/${tasks.length}] ${task.label}: ${best ? `from ${money(best.price)} (${best.from} → ${best.to}, ${best.airlines})` : `no fares (${result.error})`}${result.cached ? ' (cached)' : ''}`);
    }
  }

  const roundTripTask = (kind, group, from, [o, r], label, extra) => ({
    kind, group: group.name, out: o, ret: r, trip: TRIP.roundTrip, extra,
    legs: [{ date: o, from, to: group.airports }, { date: r, from: group.airports, to: from }],
    label,
  });

  // The cheapest (group, date pair) combinations so far, by round-trip est. total.
  function bestCombos(n, distinctGroups) {
    const seen = new Set();
    const combos = [];
    for (const t of buildTrips().filter(x => x.strategy === 'Round trip' && x.yourDates)) {
      const key = distinctGroups ? t.group : `${t.group}|${t.out}|${t.ret}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combos.push({ group: groupByName[t.group], pair: [t.out, t.ret] });
      if (combos.length >= n) break;
    }
    return combos;
  }
  function bestPairs(n) {
    const pairs = [];
    for (const t of buildTrips().filter(x => x.strategy === 'Round trip' && x.yourDates)) {
      if (!pairs.some(([o, r]) => o === t.out && r === t.ret)) pairs.push([t.out, t.ret]);
      if (pairs.length >= n) break;
    }
    return pairs.length ? pairs : datePairs.slice(0, n);
  }

  // ---------- trips ----------
  // Hops between countries once in Europe: start where you land, pass through every country
  // in visitCountries, finish where you fly home from. A non-visit group counts as one more place.
  function hopsNeeded(inGroup, outGroup) {
    const a = placeOf(inGroup);
    const b = placeOf(outGroup);
    const places = new Set([...tripCountries, a, b]);
    if (a !== b) return places.size - 1;
    return places.size > 1 ? places.size : 0;
  }

  const cheapestBy = (list, keyOf) => {
    const best = new Map();
    for (const r of list) {
      const k = keyOf(r);
      if (!best.has(k) || best.get(k).price > r.price) best.set(k, r);
    }
    return [...best.values()];
  };
  const minutesOf = s => Date.parse(`${s.replace(' ', 'T')}:00Z`) / 60000;

  function buildTrips() {
    const trips = [];
    const add = t => {
      const nights = nightsBetween(t.out, t.ret);
      if (!nightsOk(t.out, t.ret)) return;
      const hops = hopsNeeded(t.group, t.group2 || t.group);
      const ground = (groundCost(t.home, nights) + groundCost(t.home2 || t.home, nights)) / 2;
      trips.push({ ...t, nights, hops, driveAndPark: ground, total: t.airfare + ground + hops * CONFIG.hopCost * CONFIG.adults, yourDates: yourDates(t.out, t.ret) });
    };
    for (const r of rows.filter(x => x.kind === 'RT')) {
      add({
        strategy: 'Round trip', route: `${r.from} ⇄ ${r.to}`, group: r.group, home: r.from,
        from: r.from, to: r.to, out: r.out, ret: r.ret, airfare: r.price,
        airlines: r.airlines, stops: String(r.stops), flights: r.flights, times: `${r.depart} → ${r.arrive}`, layovers: r.layovers,
        // The price may return from another airport in the group; the link asks for any of
        // them back to the airport you left from.
        link: searchUrl(TRIP.roundTrip, [{ date: r.out, from: [r.from], to: [r.to] }, { date: r.ret, from: groupByName[r.group].airports, to: [r.from] }]),
      });
    }
    // Two tickets through a US hub: each transatlantic fare from the hub × the domestic
    // round trips to that hub that land early enough.
    const positioning = rows.filter(x => x.kind === 'POS');
    for (const t of rows.filter(x => x.kind === 'HUB')) {
      for (const p of positioning.filter(x => x.to === t.from && x.out === t.out && x.ret === t.ret)) {
        const gapHours = (minutesOf(t.depart) - minutesOf(p.arrive)) / 60;
        if (!(gapHours >= CONFIG.hubConnectionHours)) continue;
        add({
          strategy: 'Via US hub (2 tickets)', route: `${p.from} → ${t.from} → ${t.to}`, group: t.group, home: p.from,
          from: p.from, to: t.to, out: t.out, ret: t.ret, airfare: p.price + t.price,
          airlines: `${p.airlines} / ${t.airlines}`, stops: `${p.stops}+${t.stops}`, flights: `${p.flights} / ${t.flights}`,
          times: `${p.depart} → ${p.arrive}, ${t.depart} → ${t.arrive} (${Math.floor(gapHours)}h at ${t.from})`,
          layovers: [p.layovers, t.layovers].filter(Boolean).join(' / '),
          link: searchUrl(TRIP.roundTrip, [{ date: t.out, from: [p.from], to: [t.from] }, { date: t.ret, from: [t.from], to: [p.from] }]),
          link2: searchUrl(TRIP.roundTrip, [{ date: t.out, from: [t.from], to: [t.to] }, { date: t.ret, from: groupByName[t.group].airports, to: [t.from] }]),
        });
      }
    }
    const outs = cheapestBy(rows.filter(x => x.kind === 'OW-out'), r => `${r.out}|${r.from}|${r.to}`);
    const backs = cheapestBy(rows.filter(x => x.kind === 'OW-back'), r => `${r.out}|${r.from}|${r.to}`);
    for (const a of outs) {
      for (const b of backs) {
        if (!CONFIG.mixHomeAirports && b.to !== a.from) continue;
        add({
          strategy: 'Two one-ways', route: `${a.from} → ${a.to} … ${b.from} → ${b.to}`, group: a.group, group2: b.group, home: a.from, home2: b.to,
          from: a.from, to: a.to, from2: b.from, to2: b.to, out: a.out, ret: b.out, airfare: a.price + b.price,
          airlines: a.airlines === b.airlines ? a.airlines : `${a.airlines} / ${b.airlines}`,
          stops: `${a.stops}+${b.stops}`, flights: `${a.flights} / ${b.flights}`,
          times: `${a.depart} → ${a.arrive} / ${b.depart} → ${b.arrive}`,
          layovers: [a.layovers, b.layovers].filter(Boolean).join(' / '),
          link: searchUrl(TRIP.oneWay, [{ date: a.out, from: [a.from], to: [a.to] }]),
          link2: searchUrl(TRIP.oneWay, [{ date: b.out, from: [b.from], to: [b.to] }]),
        });
      }
    }
    return trips.sort((a, b) => a.total - b.total || a.airfare - b.airfare);
  }

  const bestPerRoute = trips => {
    const seen = new Set();
    return trips.filter(t => {
      const key = `${t.strategy}|${t.route}`;
      return !seen.has(key) && seen.add(key);
    });
  };

  // ---------- plan ----------
  const mainGroups = groups.filter(g => g.main);
  const moreGroups = groups.filter(g => !g.main);
  const nPairs = Math.min(CONFIG.bestDatePairs, datePairs.length);
  const plan = {
    'Round trips': datePairs.length * mainGroups.length,
    'More places': moreGroups.length * nPairs,
    'Each home airport': eachHome.length * Math.min(2, groups.length),
    'Via US hubs': (CONFIG.usHubs || []).length ? Math.min(2, groups.length) * 5 : 0,
    'One-ways': CONFIG.searchOneWays ? (departDays.length + returnDays.length) * mainGroups.length : 0,
    'Other weeks': Math.min(2, groups.length) * (CONFIG.otherWeeks || []).length,
  };
  const planned = Object.values(plan).reduce((a, b) => a + b, 0);
  const avgSeconds = (CONFIG.delayMs[0] + CONFIG.delayMs[1]) / 2000 + 2;
  console.log(`%cGoogle Flights fare finder: up to ${planned} searches (~${Math.ceil((planned * avgSeconds) / 60)} min if none are cached). `
    + `Departing ${CONFIG.departDates.join('–')}, returning ${CONFIG.returnDates.join('–')}, from ${homes.join('/')}.`, 'font-weight:bold;font-size:13px');
  console.log(Object.entries(plan).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(' · '));
  if (planned > CONFIG.maxRequests) {
    console.error(`That's more than maxRequests (${CONFIG.maxRequests}). Narrow the dates or groups, turn off some of the extra searches, or raise maxRequests.`);
    return;
  }
  if (CONFIG.departDates[0] < isoDay(Date.now())) console.warn('departDates starts in the past; those dates will come back empty.');
  const typicalNights = Math.max(0, nightsBetween(CONFIG.departDates[0], CONFIG.returnDates[0]));
  console.log(`Drive + parking for a ${typicalNights}-night trip: ${[...new Set([...homes, ...eachHome])].map(a => `${a} ${money(groundCost(a, typicalNights))}`).join(' · ')}`);

  window.GF_FARE_STOP = false; // clear a stop left over from an earlier run
  let haltedBy = null;
  try {
    // 1. The date grid, all home airports at once.
    await runTasks('Round trips', datePairs.flatMap(([o, r]) => mainGroups.map(g =>
      roundTripTask('RT', g, homes, [o, r], `${pairLabel(o, r)}  home ⇄ ${g.name}`))));

    // 2. More places on the cheapest date pairs.
    const pairs = bestPairs(nPairs);
    await runTasks('More places', pairs.flatMap(p => moreGroups.map(g =>
      roundTripTask('RT', g, homes, p, `${pairLabel(...p)}  home ⇄ ${g.name}`))));

    // 3. Each home airport on its own, for the two cheapest groups on their best dates.
    await runTasks('Each home airport', bestCombos(2, true).flatMap(({ group, pair }) => eachHome.map(h =>
      roundTripTask('RT', group, [h], pair, `${pairLabel(...pair)}  ${h} ⇄ ${group.name}`))));

    // 4. Two tickets through a US hub: find the cheapest hubs with one search from all of
    //    them, re-price the two cheapest on their own (so you fly back to the same hub), then
    //    a domestic round trip from home to each.
    if ((CONFIG.usHubs || []).length) {
      const scans = bestCombos(2, true).map(({ group, pair }) =>
        roundTripTask('HUBSCAN', group, CONFIG.usHubs, pair, `${pairLabel(...pair)}  US hubs ⇄ ${group.name}`));
      await runTasks('Via US hubs', scans);
      const hubTasks = [];
      const posTasks = [];
      for (const scan of scans) {
        for (const hub of cheapestBy(scan.rows || [], r => r.from).sort((a, b) => a.price - b.price).slice(0, 2).map(r => r.from)) {
          hubTasks.push(roundTripTask('HUB', groupByName[scan.group], [hub], [scan.out, scan.ret], `${pairLabel(scan.out, scan.ret)}  ${hub} ⇄ ${scan.group}`));
          if (posTasks.some(p => p.legs[0].to[0] === hub && p.out === scan.out && p.ret === scan.ret)) continue;
          posTasks.push({
            kind: 'POS', group: scan.group, out: scan.out, ret: scan.ret, trip: TRIP.roundTrip,
            legs: [{ date: scan.out, from: homes, to: [hub] }, { date: scan.ret, from: [hub], to: homes }],
            label: `${pairLabel(scan.out, scan.ret)}  home ⇄ ${hub} (to catch the flight to ${scan.group})`,
          });
        }
      }
      await runTasks('Via US hubs: from each hub', hubTasks);
      await runTasks('Via US hubs: getting to the hub', posTasks);
    }

    // 5. One-way tickets each way.
    if (CONFIG.searchOneWays) {
      await runTasks('One-ways', [
        ...departDays.flatMap(o => mainGroups.map(g => ({ kind: 'OW-out', group: g.name, out: o, trip: TRIP.oneWay, legs: [{ date: o, from: homes, to: g.airports }], label: `${o}  home → ${g.name} one-way` }))),
        ...returnDays.flatMap(r => mainGroups.map(g => ({ kind: 'OW-back', group: g.name, out: r, trip: TRIP.oneWay, legs: [{ date: r, from: g.airports, to: homes }], label: `${r}  ${g.name} → home one-way` }))),
      ]);
    }

    // 6. The two cheapest trips moved earlier or later.
    await runTasks('Other weeks', bestCombos(2, true).flatMap(({ group, pair }) => (CONFIG.otherWeeks || []).map(k => {
      const shifted = [addDays(pair[0], k), addDays(pair[1], k)];
      return roundTripTask('RT', group, homes, shifted, `${pairLabel(...shifted)}  home ⇄ ${group.name} (${k > 0 ? '+' : ''}${k} days)`);
    })).filter(t => t.out > isoDay(Date.now() + DAY)));
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    haltedBy = e.message;
    console.warn(`Stopped early: ${e.message}. Ranking what was found so far; re-run later to continue (finished searches are cached).`);
  }

  // ---------- results ----------
  const trips = buildTrips();
  const best = bestPerRoute(trips.filter(t => t.yourDates));

  const display = t => ({
    strategy: t.strategy,
    route: t.route,
    depart: t.out,
    return: t.ret,
    nights: t.nights,
    airlines: t.airlines,
    stops: t.stops,
    airfare: money(t.airfare),
    'drive + park': money(t.driveAndPark),
    'Europe hops': t.hops,
    'est. total': money(t.total),
  });

  console.log(`%cDone: ${requests} searches sent, ${rows.length} itineraries, ${trips.length} trip options.${haltedBy ? ' (partial)' : ''}`, 'font-weight:bold;font-size:13px');
  if (!trips.length) {
    console.warn(haltedBy
      ? 'Nothing to rank: the searches stopped before any fares came back (see the message above).'
      : 'No fares matched. Check the dates (future, within the ranges), the nights limits and the airport codes.');
    return;
  }

  if (best.length) {
    console.log(`%cCheapest by strategy on your dates (est. total = airfare + drive & parking + ${money(CONFIG.hopCost)} per person per hop between ${tripCountries.join(' and ')}):`, 'font-weight:bold');
    console.table(best.filter((t, i, all) => all.findIndex(x => x.strategy === t.strategy) === i).map(display));
    console.log(`%cTop ${CONFIG.showTop} routes on your dates (best dates for each):`, 'font-weight:bold');
    console.table(best.slice(0, CONFIG.showTop).map(display));
  }

  const byHome = [...new Set([...homes, ...eachHome])]
    .map(h => best.find(t => t.home === h && t.strategy === 'Round trip'))
    .filter(Boolean)
    .sort((a, b) => a.total - b.total);
  if (byHome.length) {
    console.log('%cBest round trip from each home airport, drive and parking included:', 'font-weight:bold');
    console.table(byHome.map(display));
  }

  const byGroup = groups.map(g => best.find(t => t.strategy === 'Round trip' && t.group === g.name)).filter(Boolean);
  if (byGroup.length) {
    console.log('%cCheapest round trip into each destination group:', 'font-weight:bold');
    console.table(byGroup.map(t => ({ group: t.group, counts_as: placeOf(t.group), ...display(t) })));
  }

  const hubTrips = best.filter(t => t.strategy === 'Via US hub (2 tickets)');
  if (hubTrips.length) {
    console.log(`%cTwo tickets through a US hub (at least ${CONFIG.hubConnectionHours}h to connect on the way out; check the way back too):`, 'font-weight:bold');
    console.table(hubTrips.slice(0, 10).map(t => ({ ...display(t), times: t.times })));
  } else if (rows.some(r => r.kind === 'HUB') && rows.some(r => r.kind === 'POS')) {
    console.log(`No US-hub combination left at least ${CONFIG.hubConnectionHours}h to connect.`);
  } else if (rows.some(r => r.kind === 'HUBSCAN')) {
    console.log('The US-hub searches didn\'t finish or found no flights to the hub; re-run to complete them (finished searches are cached).');
  }

  const grid = {};
  for (const t of trips.filter(x => x.yourDates)) {
    grid[t.out] = grid[t.out] || {};
    if (!(t.ret in grid[t.out]) || grid[t.out][t.ret] > t.total) grid[t.out][t.ret] = t.total;
  }
  console.log('%cCheapest est. total by departure (rows) × return (columns):', 'font-weight:bold');
  const table = {};
  for (const o of departDays) {
    table[o] = {};
    for (const r of returnDays) table[o][r] = grid[o]?.[r] != null ? money(grid[o][r]) : '—';
  }
  console.table(table);

  // Other dates: shifted searches that beat your best option, then Google's own hints.
  const bestTotal = best.length ? best[0].total : Infinity;
  const otherDates = bestPerRoute(trips.filter(t => !t.yourDates)).filter(t => t.total < bestTotal).slice(0, 10);
  if (otherDates.length) {
    console.log('%cCheaper if you can move the trip:', 'font-weight:bold');
    console.table(otherDates.map(t => ({ ...display(t), 'vs your best': bestTotal < Infinity ? `−${money(bestTotal - t.total)}` : '' })));
  }
  const newHints = cheapestBy(hints, h => `${h.kind}|${h.group}|${h.out}|${h.ret}`)
    .filter(h => (h.kind === 'OW-back'
      ? !inRange(h.out, CONFIG.returnDates)
      : !(inRange(h.out, CONFIG.departDates) && (!h.ret || inRange(h.ret, CONFIG.returnDates)))))
    .sort((a, b) => a.price - b.price)
    .slice(0, 10);
  if (newHints.length) {
    console.log('%cGoogle suggested cheaper dates outside your ranges (airfare only):', 'font-weight:bold');
    console.table(newHints.map(h => ({
      search: h.kind === 'OW-back' ? `one-way ${h.group} → home` : h.kind === 'OW-out' ? `one-way home → ${h.group}` : `round trip ${h.group}`,
      date: h.ret ? `${h.out} → ${h.ret}` : h.out,
      airfare: money(h.price),
    })));
  }

  // Multi-city can't be priced from the page. Suggest the most promising: into the cheap
  // airports of one visit country and home from the other, scored by the cheapest one-way
  // (or round-trip) fares there, on the dates of your best round trip.
  const multiCity = [];
  if (visitGroups.length > 1 && CONFIG.multiCityLinks > 0 && best.length) {
    const dates = best.find(t => t.strategy === 'Round trip') || best[0];
    // Score with fares from your home airports on these dates (one-ways, or half a round
    // trip); for an airport with none, any fare from your home airports on your dates.
    const priceInto = {};
    const priceOutOf = {};
    const looseInto = {};
    const looseOutOf = {};
    const keep = (map, airport, price) => { map[airport] = Math.min(map[airport] ?? Infinity, price); };
    for (const r of rows.filter(x => x.fromHomes)) {
      const onDates = r.kind === 'OW-back' ? r.out === dates.ret : r.out === dates.out && (r.kind !== 'RT' || r.ret === dates.ret);
      const inYourDates = r.kind === 'RT' ? yourDates(r.out, r.ret) : inRange(r.out, r.kind === 'OW-back' ? CONFIG.returnDates : CONFIG.departDates);
      if (!inYourDates) continue;
      if (r.kind === 'OW-out' || r.kind === 'RT') keep(onDates ? priceInto : looseInto, r.to, r.kind === 'RT' ? r.price / 2 : r.price);
      if (r.kind === 'OW-back') keep(onDates ? priceOutOf : looseOutOf, r.from, r.price);
      if (r.kind === 'RT') keep(onDates ? priceOutOf : looseOutOf, r.to, r.price / 2);
    }
    for (const [a, p] of Object.entries(looseInto)) if (priceInto[a] == null) priceInto[a] = p;
    for (const [a, p] of Object.entries(looseOutOf)) if (priceOutOf[a] == null) priceOutOf[a] = p;
    const cheapest = (airports, prices) => airports.filter(a => prices[a] != null).sort((a, b) => prices[a] - prices[b]).slice(0, 2);
    for (const a of visitGroups) {
      for (const b of visitGroups.filter(x => x !== a)) {
        for (const x of cheapest(a.airports, priceInto)) {
          for (const y of cheapest(b.airports, priceOutOf)) {
            multiCity.push({
              route: `home → ${x} … ${y} → home`, depart: dates.out, return: dates.ret, score: priceInto[x] + priceOutOf[y],
              link: searchUrl(TRIP.multiCity, [{ date: dates.out, from: homes, to: [x] }, { date: dates.ret, from: [y], to: homes }]),
            });
          }
        }
      }
    }
    multiCity.sort((p, q) => p.score - q.score);
    if (multiCity.length) {
      console.log('%cMulti-city searches worth opening by hand (one hop fewer than a round trip; Google only prices these in the page):', 'font-weight:bold');
      multiCity.slice(0, CONFIG.multiCityLinks).forEach((m, i) => console.log(`${i + 1}. ${m.route}, ${m.depart} → ${m.return} (score ≈ ${money(m.score)}: one-ways, or half a round trip, to and from those airports)\n   ${m.link}`));
    }
  }

  console.log('%cOpen the top 5 on Google Flights:', 'font-weight:bold');
  best.slice(0, 5).forEach((t, i) => {
    console.log(`${i + 1}. ${money(t.total)} est. (${money(t.airfare)} airfare + ${money(t.driveAndPark)} drive & parking) ${t.strategy} ${t.route}, ${t.out} → ${t.ret}, ${t.airlines}, ${t.flights}\n   ${t.link}${t.link2 ? `\n   ${t.link2}` : ''}`);
  });
  console.log('Prices are for the whole party before bag fees, and change by the minute. A round-trip price is the cheapest total starting with the listed outbound flight. '
    + 'Each search only sees the top few flights Google lists, so "Each home airport" is the fair comparison between airports.');

  const csvCell = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const columns = ['strategy', 'route', 'group', 'from', 'to', 'from2', 'to2', 'out', 'ret', 'nights', 'airlines', 'stops', 'flights', 'times', 'layovers', 'airfare', 'driveAndPark', 'hops', 'total', 'yourDates', 'link', 'link2'];
  const csv = [columns.join(','), ...trips.map(t => columns.map(c => csvCell(t[c])).join(','))].join('\n');

  const exported = { config: CONFIG, rows, hints };
  window.googleFares = { config: CONFIG, rows, hints, trips, bestPerRoute: best, otherDates, multiCity, csv, export: exported };
  console.log('Everything is in window.googleFares (rows = raw itineraries, trips = every combination, hints = Google\'s date suggestions).');

  if (CONFIG.download) {
    const save = (name, text, type) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    console.log('Downloading google-trips (CSV) and google-fares (JSON). If the browser asks to allow multiple downloads, allow it. '
      + 'If the JSON doesn\'t arrive, type  copy(JSON.stringify(googleFares.export))  here and paste it into a file.');
    save(`google-trips-${stamp}.csv`, csv, 'text/csv');
    save(`google-fares-${stamp}.json`, JSON.stringify(exported), 'application/json');
  }
})();
