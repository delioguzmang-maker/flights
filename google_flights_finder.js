/*
 * Google Flights fare finder — DevTools console script
 *
 * Searches every airline Google Flights knows about (not just Delta) from all your home
 * airports at once, for every departure/return date pair in a range, and ranks round
 * trips and pairs of one-way tickets by what the whole trip costs, including getting
 * between countries once you're in Europe. Each result gets a link that opens the exact
 * search on Google Flights so you can book it.
 *
 * How it searches: it loads the same results page you'd open in a tab (one per search)
 * and reads the flights embedded in it. Google's internal search API now needs a token
 * only its own page code can make, so the script doesn't call it. Multi-city prices only
 * load through that API, so instead of pricing them the script prints ready-made
 * multi-city links for the most promising combinations, to check by hand.
 *
 * HOW TO RUN
 *   1. Open https://www.google.com/travel/flights in Chrome or Edge. Signed in or not both work.
 *   2. Open DevTools (F12, or Cmd+Option+J on a Mac) and pick the Console tab.
 *   3. Change CONFIG below if you want, paste this whole file and press Enter.
 *      Chrome may first ask you to type "allow pasting".
 *   4. Leave the tab open. Progress prints as it goes (the default plan is ~90 searches,
 *      about 8–10 minutes). Results print as tables and download as CSV + JSON.
 *
 * Stop early:  window.GF_FARE_STOP = true   (the results so far are still ranked)
 * Re-running is cheap: searches from the last few hours are reused from localStorage.
 * Override settings without editing:  window.GF_FARE_CONFIG = { hopCost: 60 }  then paste.
 */
(async () => {
  'use strict';

  const CONFIG = Object.assign({
    // Searched together in every search (Google allows up to 7 airports per side).
    homeAirports: ['CHS', 'CAE', 'GSP', 'CLT'],
    // What using each home airport costs you (gas, parking), added once per trip.
    homeAirportExtraCost: { CHS: 0, CAE: 0, GSP: 0, CLT: 0 },

    // Destination groups, up to 7 airports each; each group is one search per date pair.
    // Groups named in visitCountries are the countries you must see. Any other group is an
    // alternative gateway you'd continue from by train or budget flight.
    destinations: {
      Germany: ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR', 'CGN'],
      Italy: ['FCO', 'MXP', 'VCE', 'NAP', 'BLQ', 'FLR', 'PSA'],
      'Other hubs': ['MAD', 'BCN', 'AMS', 'CDG', 'DUB', 'LIS', 'ZRH'],
    },
    visitCountries: ['Germany', 'Italy'],
    // Your estimate (per person) for one train / budget-airline hop between countries.
    hopCost: 75,

    // Date ranges, inclusive; every departure × return pair inside the nights limits is searched.
    departDates: ['2026-12-12', '2026-12-16'],
    returnDates: ['2026-12-21', '2026-12-24'],
    minNights: 1,
    maxNights: 30,

    adults: 1,
    seat: 1, // 1 economy, 2 premium economy, 3 business, 4 first
    maxStops: null, // null any, 0 nonstop only, 1 one stop or fewer, 2 two stops or fewer

    searchRoundTrips: true, // home ⇄ each destination group
    searchOneWays: true, // separate one-way tickets (budget transatlantic carriers show up here)
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
  }, window.GF_FARE_CONFIG || {});

  const CACHE_KEY = 'gfFareFinder.v2';
  const TRIP = { roundTrip: 1, oneWay: 2, multiCity: 3 };

  if (!/^www\.google\.[a-z.]+$/.test(location.hostname)) {
    console.error('Run this from a Google Flights tab (https://www.google.com/travel/flights).');
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
  const datePairs = departDays.flatMap(o => returnDays.filter(r => nightsOk(o, r)).map(r => [o, r]));

  const money = n => (n == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: CONFIG.currency, maximumFractionDigits: 0 }).format(n));

  // ---------- places ----------
  const homes = CONFIG.homeAirports;
  const groups = Object.entries(CONFIG.destinations).map(([name, airports]) => ({ name, airports }));
  const tripCountries = CONFIG.visitCountries.filter(c => CONFIG.destinations[c]);
  const visitGroups = groups.filter(g => tripCountries.includes(g.name));
  for (const list of [homes, ...groups.map(g => g.airports)]) {
    if (list.length > 7) console.warn(`More than 7 airports in one field (${list.join(', ')}); Google may ignore some.`);
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

  // The results page embeds its flights in AF_initDataCallback({key: 'ds:1', ..., data: [...], sideChannel: {}}).
  function pagePayload(html) {
    const at = html.indexOf("key: 'ds:1'");
    if (at < 0) return null;
    const start = html.indexOf('data:', at);
    const end = html.indexOf(', sideChannel', start);
    if (start < 0 || end < 0) return null;
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
  async function search(trip, legs) {
    const url = searchUrl(trip, legs);
    if (cache[url]) return { ...cache[url], cached: true };
    if (window.GF_FARE_STOP) throw new Halt('stopped by GF_FARE_STOP');
    if (requests >= CONFIG.maxRequests) throw new Halt(`reached maxRequests (${CONFIG.maxRequests})`);
    if (requests > 0) await sleep(CONFIG.delayMs[0] + Math.random() * (CONFIG.delayMs[1] - CONFIG.delayMs[0]));
    requests++;
    const { status, payload } = await fetchPage(url);
    if (!payload) return { itineraries: [], hints: [], error: `HTTP ${status}, no results on the page` }; // not cached: may load next time
    const entry = { t: Date.now(), ...parsePayload(payload) };
    if (!entry.itineraries.length) entry.error = 'no flights found';
    cache[url] = entry;
    saveCache();
    return entry;
  }

  // ---------- plan ----------
  const tasks = [];
  if (CONFIG.searchRoundTrips) {
    for (const [o, r] of datePairs) {
      for (const g of groups) {
        tasks.push({
          phase: 'Round trips', kind: 'RT', group: g.name, out: o, ret: r, trip: TRIP.roundTrip,
          legs: [{ date: o, from: homes, to: g.airports }, { date: r, from: g.airports, to: homes }],
          label: `${o} → ${r}  home ⇄ ${g.name}`,
        });
      }
    }
  }
  if (CONFIG.searchOneWays) {
    for (const o of departDays) {
      for (const g of groups) {
        tasks.push({ phase: 'One-ways', kind: 'OW-out', group: g.name, out: o, trip: TRIP.oneWay, legs: [{ date: o, from: homes, to: g.airports }], label: `${o}  home → ${g.name} one-way` });
      }
    }
    for (const r of returnDays) {
      for (const g of groups) {
        tasks.push({ phase: 'One-ways', kind: 'OW-back', group: g.name, out: r, trip: TRIP.oneWay, legs: [{ date: r, from: g.airports, to: homes }], label: `${r}  ${g.name} → home one-way` });
      }
    }
  }

  const avgSeconds = (CONFIG.delayMs[0] + CONFIG.delayMs[1]) / 2000 + 2;
  console.log(`%cGoogle Flights fare finder: up to ${tasks.length} searches (~${Math.ceil((tasks.length * avgSeconds) / 60)} min if none are cached). `
    + `Departing ${CONFIG.departDates.join('–')}, returning ${CONFIG.returnDates.join('–')}, from ${homes.join('/')}.`, 'font-weight:bold;font-size:13px');
  if (tasks.length > CONFIG.maxRequests) {
    console.error(`That's more than maxRequests (${CONFIG.maxRequests}). Narrow the dates or groups, or raise maxRequests.`);
    return;
  }
  if (CONFIG.departDates[0] < isoDay(Date.now())) console.warn('departDates starts in the past; those dates will come back empty.');

  window.GF_FARE_STOP = false; // clear a stop left over from an earlier run
  const rows = [];
  const hints = [];
  let haltedBy = null;
  try {
    let current = '';
    for (const [n, task] of tasks.entries()) {
      if (task.phase !== current) {
        current = task.phase;
        console.log(`%c${current}: ${tasks.filter(t => t.phase === current).length} searches`, 'font-weight:bold');
      }
      const result = await search(task.trip, task.legs);
      for (const it of result.itineraries) rows.push({ kind: task.kind, group: task.group, out: task.out, ret: task.ret || null, ...it });
      for (const h of result.hints) hints.push({ kind: task.kind, group: task.group, ...h });
      const best = result.itineraries[0];
      console.log(`[${n + 1}/${tasks.length}] ${task.label}: ${best ? `from ${money(best.price)} (${best.from} → ${best.to}, ${best.airlines})` : `no fares (${result.error})`}${result.cached ? ' (cached)' : ''}`);
    }
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    haltedBy = e.message;
    console.warn(`Stopped early: ${e.message}. Ranking what was found so far; re-run later to continue (finished searches are cached).`);
  }

  // ---------- rank ----------
  // Hops between countries once in Europe: start in the arrival group, pass through every
  // country in visitCountries, finish in the departure group. A non-visit group (e.g.
  // "Other hubs") counts as one extra place to travel through.
  function hopsNeeded(inGroup, outGroup) {
    const places = new Set([...tripCountries, inGroup, outGroup]);
    if (inGroup !== outGroup) return places.size - 1;
    return places.size > 1 ? places.size : 0;
  }
  const homeCost = (a, b) => ((CONFIG.homeAirportExtraCost[a] || 0) + (CONFIG.homeAirportExtraCost[b] || 0)) / 2;

  const trips = [];
  const addTrip = t => {
    const hops = hopsNeeded(t.inGroup, t.outGroup);
    trips.push({ ...t, nights: nightsBetween(t.out, t.ret), hops, total: t.airfare + hops * CONFIG.hopCost * CONFIG.adults + homeCost(t.from, t.to2) });
  };
  for (const r of rows.filter(x => x.kind === 'RT')) {
    addTrip({
      strategy: 'Round trip', route: `${r.from} ⇄ ${r.to}`,
      from: r.from, to: r.to, from2: r.to, to2: r.from, inGroup: r.group, outGroup: r.group,
      out: r.out, ret: r.ret, airfare: r.price,
      airlines: r.airlines, stops: String(r.stops), flights: r.flights, times: `${r.depart} → ${r.arrive}`, layovers: r.layovers,
      link: searchUrl(TRIP.roundTrip, [{ date: r.out, from: [r.from], to: [r.to] }, { date: r.ret, from: [r.to], to: [r.from] }]),
    });
  }
  // Pair one-ways: cheapest outbound per (date, airport pair) × cheapest return.
  const cheapestBy = (list, keyOf) => {
    const best = new Map();
    for (const r of list) {
      const k = keyOf(r);
      if (!best.has(k) || best.get(k).price > r.price) best.set(k, r);
    }
    return [...best.values()];
  };
  const outs = cheapestBy(rows.filter(x => x.kind === 'OW-out'), r => `${r.out}|${r.from}|${r.to}`);
  const backs = cheapestBy(rows.filter(x => x.kind === 'OW-back'), r => `${r.out}|${r.from}|${r.to}`);
  for (const a of outs) {
    for (const b of backs) {
      if ((!CONFIG.mixHomeAirports && b.to !== a.from) || !nightsOk(a.out, b.out)) continue;
      addTrip({
        strategy: 'Two one-ways', route: `${a.from} → ${a.to} … ${b.from} → ${b.to}`,
        from: a.from, to: a.to, from2: b.from, to2: b.to, inGroup: a.group, outGroup: b.group,
        out: a.out, ret: b.out, airfare: a.price + b.price,
        airlines: a.airlines === b.airlines ? a.airlines : `${a.airlines} / ${b.airlines}`,
        stops: `${a.stops}+${b.stops}`, flights: `${a.flights} / ${b.flights}`,
        times: `${a.depart} → ${a.arrive} / ${b.depart} → ${b.arrive}`,
        layovers: [a.layovers, b.layovers].filter(Boolean).join(' / '),
        link: searchUrl(TRIP.oneWay, [{ date: a.out, from: [a.from], to: [a.to] }]),
        link2: searchUrl(TRIP.oneWay, [{ date: b.out, from: [b.from], to: [b.to] }]),
      });
    }
  }
  trips.sort((a, b) => a.total - b.total || a.airfare - b.airfare);

  const seen = new Set();
  const bestPerRoute = trips.filter(t => {
    const key = `${t.strategy}|${t.route}`;
    return !seen.has(key) && seen.add(key);
  });

  const display = t => ({
    strategy: t.strategy,
    route: t.route,
    depart: t.out,
    return: t.ret,
    nights: t.nights,
    airlines: t.airlines,
    stops: t.stops,
    airfare: money(t.airfare),
    'Europe hops': t.hops,
    'est. total': money(t.total),
  });

  console.log(`%cDone: ${requests} searches sent, ${rows.length} itineraries, ${trips.length} trip options.${haltedBy ? ' (partial)' : ''}`, 'font-weight:bold;font-size:13px');
  if (!trips.length) {
    console.warn('No fares matched. Check the dates (future, within the ranges), the nights limits and the airport codes.');
    return;
  }

  console.log(`%cCheapest by strategy (est. total includes ${money(CONFIG.hopCost)} per person per hop between ${tripCountries.join(' and ')}):`, 'font-weight:bold');
  console.table(bestPerRoute.filter((t, i, all) => all.findIndex(x => x.strategy === t.strategy) === i).map(display));

  console.log(`%cTop ${CONFIG.showTop} routes (best dates for each):`, 'font-weight:bold');
  console.table(bestPerRoute.slice(0, CONFIG.showTop).map(display));

  const grid = {};
  for (const t of trips) {
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

  const newHints = cheapestBy(hints, h => `${h.kind}|${h.group}|${h.out}|${h.ret}`)
    .filter(h => !(inRange(h.out, CONFIG.departDates) && (!h.ret || inRange(h.ret, CONFIG.returnDates))))
    .sort((a, b) => a.price - b.price)
    .slice(0, 10);
  if (newHints.length) {
    console.log('%cGoogle suggested cheaper dates outside your ranges (airfare only):', 'font-weight:bold');
    console.table(newHints.map(h => ({ search: `${h.kind === 'RT' ? 'round trip' : 'one-way'} ${h.group}`, depart: h.out, return: h.ret || '', airfare: money(h.price) })));
  }

  // Multi-city can't be priced from the page, so suggest the most promising ones to open by
  // hand: into the cheapest airports of one visit country, home from the cheapest of another,
  // on the dates of the cheapest round trip to either.
  const multiCity = [];
  if (visitGroups.length > 1 && CONFIG.multiCityLinks > 0) {
    const cheapestAirports = (group, side) => cheapestBy(rows.filter(r => r.group === group && r.kind !== 'OW-back'), r => r.to)
      .concat(side === 'from' ? cheapestBy(rows.filter(r => r.group === group && r.kind === 'OW-back'), r => r.from).map(r => ({ ...r, to: r.from })) : [])
      .sort((a, b) => a.price - b.price)
      .map(r => r.to)
      .filter((a, i, all) => all.indexOf(a) === i)
      .slice(0, 2);
    for (const a of visitGroups) {
      for (const b of visitGroups.filter(x => x !== a)) {
        const dates = trips.find(t => t.strategy === 'Round trip' && (t.inGroup === a.name || t.inGroup === b.name));
        if (!dates) continue;
        for (const x of cheapestAirports(a.name, 'to')) {
          for (const y of cheapestAirports(b.name, 'from')) {
            multiCity.push({
              route: `home → ${x} … ${y} → home`, depart: dates.out, return: dates.ret,
              link: searchUrl(TRIP.multiCity, [{ date: dates.out, from: homes, to: [x] }, { date: dates.ret, from: [y], to: homes }]),
            });
          }
        }
      }
    }
    if (multiCity.length) {
      console.log('%cMulti-city searches worth opening by hand (one hop fewer than a round trip; Google only prices these in the page):', 'font-weight:bold');
      multiCity.slice(0, CONFIG.multiCityLinks).forEach((m, i) => console.log(`${i + 1}. ${m.route}, ${m.depart} → ${m.return}\n   ${m.link}`));
    }
  }

  console.log('%cOpen the top 5 on Google Flights:', 'font-weight:bold');
  bestPerRoute.slice(0, 5).forEach((t, i) => {
    console.log(`${i + 1}. ${money(t.total)} est. (${money(t.airfare)} airfare) ${t.strategy} ${t.route}, ${t.out} → ${t.ret}, ${t.airlines}, ${t.flights}\n   ${t.link}${t.link2 ? `\n   ${t.link2}` : ''}`);
  });
  console.log('Prices are for the whole party before bag fees, and change by the minute. A round-trip price is the cheapest total starting with the listed outbound flight.');

  const csvCell = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const columns = ['strategy', 'route', 'from', 'to', 'from2', 'to2', 'out', 'ret', 'nights', 'airlines', 'stops', 'flights', 'times', 'layovers', 'airfare', 'hops', 'total', 'link', 'link2'];
  const csv = [columns.join(','), ...trips.map(t => columns.map(c => csvCell(t[c])).join(','))].join('\n');

  window.googleFares = { config: CONFIG, rows, hints, trips, bestPerRoute, multiCity, csv };
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
    save(`google-trips-${stamp}.csv`, csv, 'text/csv');
    save(`google-fares-${stamp}.json`, JSON.stringify({ config: CONFIG, rows, hints }), 'application/json');
  }
})();
