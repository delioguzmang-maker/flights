/*
 * Delta fare finder — DevTools console script
 *
 * delta.com's "My dates are flexible" grid only prices one origin → one destination
 * at a time. This script asks the same API for every home airport × European airport,
 * then ranks round trips, open-jaw (multi-city) trips and pairs of one-way tickets by
 * what the whole trip costs, including getting between countries once you're in Europe.
 *
 * HOW TO RUN
 *   1. Open https://www.delta.com in Chrome or Edge (any page, logged in or not).
 *   2. Open DevTools (F12, or Cmd+Option+J on a Mac) and pick the Console tab.
 *   3. Change CONFIG below if you want (dates, airports), paste this whole file and press
 *      Enter. Chrome may first ask you to type "allow pasting".
 *   4. Leave the tab open. Progress prints as it goes (a full run is ~170 searches,
 *      about 8–10 minutes). Results print as tables and download as CSV + JSON.
 *
 * Stop early:  window.DELTA_FARE_STOP = true   (the results so far are still ranked)
 * Re-running is cheap: grids fetched in the last few hours are reused from localStorage,
 * so you can tweak hopCost, nights or airports and run again.
 * Override settings without editing:  window.DELTA_FARE_CONFIG = { hopCost: 60 }  then paste.
 */
(async () => {
  'use strict';

  const CONFIG = Object.assign({
    // Airports you can leave from and come home to.
    homeAirports: ['CHS', 'CAE', 'GSP', 'CLT'],
    // What using each home airport costs you (gas, parking), added once per trip.
    homeAirportExtraCost: { CHS: 0, CAE: 0, GSP: 0, CLT: 0 },

    // European airports to price, grouped by country.
    destinations: {
      Germany: ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR'],
      Italy: ['FCO', 'MXP', 'VCE', 'NAP', 'BLQ', 'FLR'],
    },
    // Countries the trip has to include, and your estimate (per person) for one
    // train / budget-airline hop between them. A round trip into Germany needs two hops
    // (Germany → Italy → back to Germany); flying into Germany and home from Italy needs one.
    visitCountries: ['Germany', 'Italy'],
    hopCost: 75,

    // Date ranges, inclusive. Each 7-day block of departures × 7-day block of returns
    // is one search per route, so wider ranges multiply the number of searches.
    departDates: ['2026-12-14', '2026-12-20'],
    returnDates: ['2026-12-22', '2026-12-28'],
    minNights: 1,
    maxNights: 30,

    adults: 1,
    nonStopOnly: false,
    brand: 'MAIN', // delta.com's default "Best fares for"; its grid already includes Basic Economy fares

    searchRoundTrips: true,
    searchOpenJaw: true, // multi-city: into one country, home from another
    searchOneWays: true, // two separate one-way tickets
    // Open-jaw and one-way searches only use the N cheapest airports per country
    // from the round-trip scan, to keep the number of searches down.
    gatewaysPerCountry: 3,
    // Let one-way pairs leave from one home airport and return to another.
    mixHomeAirports: false,

    delayMs: [1200, 2500], // pause between searches; keep it polite or Delta may block you for a while
    maxRequests: 400,
    cacheHours: 6,
    showTop: 25,
    download: true,
  }, window.DELTA_FARE_CONFIG || {});

  const OFFERS_URL = 'https://offer-api-prd.delta.com/prd/rm-offer-gql';
  const CALLBACK_URL = 'https://offer-api-prd.delta.com/prd/callback/';
  // delta.com's code for "still working, poll the callback URL".
  const CALLBACK_CODE = 'ROF5004_PXY1007';
  const CACHE_KEY = 'deltaFareFinder.v1';

  // The flexible-dates query delta.com sends, verbatim.
  const QUERY = `query ($offerSearchCriteria: OfferSearchCriteriaInput!) {
  gqlSearchOffers(offerSearchCriteria: $offerSearchCriteria) {
    offerResponseId
    gqlOffersSets {
      offers {
        offerId
        additionalOfferProperties {
          offered
          soldOut
          lowestFare
          totalTripStopCnt
          discountAvailable
        }
        offerPricing {
          discountsApplied {
            code
            pct
          }
          originalTotalAmt {
            currencyEquivalentPrice {
              currencyAmt
              roundedCurrencyAmt
              formattedCurrencyAmt
            }
            milesEquivalentPrice {
              mileCnt
            }
          }
          totalAmt {
            currencyEquivalentPrice {
              currencyAmt
              roundedCurrencyAmt
              formattedCurrencyAmt
            }
            milesEquivalentPrice {
              mileCnt
            }
          }
          promotionalPrices {
            code
            pct
            price {
              milesEquivalentPrice {
                mileCnt
              }
              currencyEquivalentPrice {
                currencyAmt
                roundedCurrencyAmt
                formattedCurrencyAmt
              }
            }
          }
        }
      }
      itineraryDepartureDate
    }
    offerDataList {
      pricingOptions {
        pricingOptionDetail {
          currencyCode
        }
      }
      flexReturnDates
      responseProperties {
        tripTypeText
        discountInfo {
          discountPct
          discountTypeCode
          nonDiscountedOffersAvailable
        }
        promotionsInfo {
          promotionalCode
          promotionalPct
        }
      }
    }
  }
}`;

  if (!/(^|\.)delta\.com$/.test(location.hostname)) {
    console.error('Run this from a www.delta.com tab — the browser only lets delta.com pages call Delta\'s fare API.');
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

  // Each search returns a 7×7 grid: 3 days either side of the date sent.
  const blockCenters = ([from, to]) => {
    const centers = [];
    for (let start = from; start <= to; start = addDays(start, 7)) centers.push(addDays(start, 3));
    return centers;
  };
  const outCenters = blockCenters(CONFIG.departDates);
  const retCenters = blockCenters(CONFIG.returnDates);
  // Skip block pairs where no departure/return combination fits the nights limits.
  const blockPairs = outCenters.flatMap(o => retCenters
    .filter(r => nightsBetween(o, r) + 6 >= CONFIG.minNights && nightsBetween(o, r) - 6 <= CONFIG.maxNights)
    .map(r => [o, r]));

  // ---------- money ----------
  let currency = 'USD';
  const money = n => (n == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n));

  // ---------- airports ----------
  const countryOf = {};
  for (const [country, airports] of Object.entries(CONFIG.destinations)) for (const a of airports) countryOf[a] = country;
  const allDestinations = Object.values(CONFIG.destinations).flat();
  const homes = CONFIG.homeAirports;
  const tripCountries = CONFIG.visitCountries.filter(c => CONFIG.destinations[c]);

  // ---------- API ----------
  const leg = (from, to, center) => ({
    departureLocalTs: `${center}T00:00:00`,
    destinations: [{ airportCode: to }],
    origins: [{ airportCode: from }],
    calenderDateRequest: { daysBeforeCnt: 3, daysAfterCnt: 3 }, // Delta's spelling
  });

  const searchCriteria = legs => ({
    productGroups: [{ productCategoryCode: 'FLIGHTS' }],
    customers: Array.from({ length: CONFIG.adults }, (_, i) => ({ passengerTypeCode: 'ADT', passengerId: String(i + 1) })),
    offersCriteria: {
      resultsPageNum: 4,
      pricingCriteria: { priceableIn: ['CURRENCY'] },
      preferences: { nonStopOnly: CONFIG.nonStopOnly, refundableOnly: false, excludeBrandTypes: [] },
      flightRequestCriteria: { sortByBrandId: CONFIG.brand, searchOriginDestination: legs },
    },
  });

  const transactionPrefix = crypto.randomUUID();
  // Same headers delta.com sends for a guest search.
  const offerHeaders = () => ({
    Authorization: 'GUEST',
    'Content-Type': 'application/json',
    TransactionId: `${transactionPrefix}_${Date.now()}`,
    applicationId: 'DC',
    'x-app-type': 'dcom-shop',
    'x-app-route': 'dates',
    channelId: 'DCOM',
    Airline: 'DL',
  });

  class Halt extends Error {}

  async function http(url, init) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        if (attempt >= 2) throw new Halt(`network error (${e.message}); Delta may be blocking this browser for now`);
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Halt(`HTTP ${res.status}: Delta refused the request`);
      if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
        if (attempt >= 3) throw new Halt(`HTTP ${res.status} after ${attempt + 1} tries`);
        const wait = 15000 * 2 ** attempt;
        console.warn(`HTTP ${res.status}; waiting ${wait / 1000}s before retrying`);
        await sleep(wait);
        continue;
      }
      try {
        return await res.json();
      } catch {
        return { errors: [{ message: `HTTP ${res.status}` }] };
      }
    }
  }

  // Mirrors delta.com's error mapping: "<code>_<moreInfo code>" plus callback details.
  function errorInfo(error) {
    const { code = '', moreInfo = [] } = (error && error.extensions && error.extensions.errors) || {};
    const more = moreInfo[0] || {};
    return {
      code: more.code ? (code ? `${code}_${more.code}` : more.code) : code,
      callbackId: more.callbackId || '',
      callbackInSecs: Number(more.callbackInSecs) || 0,
      message: (error && error.message) || '',
    };
  }

  // Reads the grid the way delta.com does: each offer set is one outbound date. In a
  // round-trip (or multi-city) grid its offers line up with flexReturnDates; in a
  // one-way grid the fare for set i is offers[i].
  function parseGrid(offers) {
    const props = offers.offerDataList || {};
    currency = props.pricingOptions?.[0]?.pricingOptionDetail?.currencyCode || currency;
    const oneWay = props.responseProperties?.tripTypeText === 'ONE_WAY';
    const returnDates = props.flexReturnDates || [];
    const cells = [];
    const add = (out, ret, offer) => {
      if (!offer) return;
      const p = offer.additionalOfferProperties || {};
      const amount = offer.offerPricing?.[0]?.totalAmt?.currencyEquivalentPrice?.currencyAmt;
      if (amount == null || p.soldOut || p.offered === false) return;
      cells.push([out, ret, amount, p.totalTripStopCnt ?? null]);
    };
    (offers.gqlOffersSets || []).forEach((set, i) => {
      const list = set.offers || [];
      if (oneWay) add(set.itineraryDepartureDate, null, list[i] || (list.length === 1 ? list[0] : null));
      else list.forEach((offer, j) => add(set.itineraryDepartureDate, returnDates[j], offer));
    });
    return cells;
  }

  async function fetchGrid(legs) {
    let json = await http(OFFERS_URL, {
      method: 'POST',
      credentials: 'include',
      headers: offerHeaders(),
      body: JSON.stringify({ variables: { offerSearchCriteria: searchCriteria(legs) }, query: QUERY }),
    });
    for (let polls = 0; ; polls++) {
      const offers = json?.data?.gqlSearchOffers;
      if (offers) return { cells: parseGrid(offers) };
      const err = errorInfo(json?.errors?.[0]);
      if (err.code !== CALLBACK_CODE || !err.callbackId) return { cells: [], error: err.code || err.message || 'empty response' };
      if (polls === 10) return { cells: [], error: 'gave up waiting for callback', transient: true };
      await sleep(Math.max(1, err.callbackInSecs) * 1000);
      json = await http(CALLBACK_URL + encodeURIComponent(err.callbackId), { headers: { Authorization: 'GUEST' } });
    }
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
  async function grid(legs) {
    const key = JSON.stringify([legs, CONFIG.adults, CONFIG.brand, CONFIG.nonStopOnly]);
    if (cache[key]) return { ...cache[key], cached: true };
    if (window.DELTA_FARE_STOP) throw new Halt('stopped by DELTA_FARE_STOP');
    if (requests >= CONFIG.maxRequests) throw new Halt(`reached maxRequests (${CONFIG.maxRequests})`);
    if (requests > 0) await sleep(CONFIG.delayMs[0] + Math.random() * (CONFIG.delayMs[1] - CONFIG.delayMs[0]));
    requests++;
    const result = await fetchGrid(legs);
    if (!result.transient) {
      cache[key] = { t: Date.now(), currency, cells: result.cells, error: result.error };
      saveCache();
    }
    return result;
  }

  // ---------- searches ----------
  const rows = [];

  async function runTasks(name, tasks, { bailIfUnsupported = false } = {}) {
    console.log(`%c${name}: ${tasks.length} searches`, 'font-weight:bold');
    for (const [n, task] of tasks.entries()) {
      const result = await grid(task.legs);
      if (result.cached && result.currency) currency = result.currency;
      task.result = result;
      for (const [out, ret, price, stops] of result.cells) rows.push({ ...task.row, out, ret, price, stops });
      const best = result.cells.length ? Math.min(...result.cells.map(c => c[2])) : null;
      const outcome = best != null ? `from ${money(best)}` : `no fares${result.error ? ` (${result.error})` : ''}`;
      console.log(`[${name} ${n + 1}/${tasks.length}] ${task.label}: ${outcome}${result.cached ? ' (cached)' : ''}`);
      if (bailIfUnsupported && n === 2 && tasks.slice(0, 3).every(t => t.result.error)) {
        console.warn(`${name}: the first 3 searches all failed, so Delta's flexible-dates API probably doesn't price these. Skipping the rest.`);
        return false;
      }
    }
    return true;
  }

  const datesLabel = (o, r) => (blockPairs.length > 1 ? ` [${addDays(o, -3)}…${addDays(o, 3)} / ${r ? `${addDays(r, -3)}…${addDays(r, 3)}` : ''}]` : '');

  const roundTripTasks = () => homes.flatMap(h => allDestinations.flatMap(d => blockPairs.map(([o, r]) => ({
    legs: [leg(h, d, o), leg(d, h, r)],
    row: { kind: 'RT', from: h, to: d, from2: d, to2: h },
    label: `${h} ⇄ ${d}${datesLabel(o, r)}`,
  }))));

  // The N cheapest airports per country from the round-trip scan (or the first N listed).
  function pickGateways() {
    const best = {};
    for (const r of rows) if (r.kind === 'RT') best[r.to] = Math.min(best[r.to] ?? Infinity, r.price);
    const picked = {};
    for (const [country, airports] of Object.entries(CONFIG.destinations)) {
      const priced = airports.filter(a => best[a] != null).sort((a, b) => best[a] - best[b]);
      picked[country] = (priced.length ? priced : airports).slice(0, CONFIG.gatewaysPerCountry);
    }
    return picked;
  }

  const openJawTasks = gateways => tripCountries.flatMap(inC => tripCountries.filter(c => c !== inC).flatMap(outC =>
    homes.flatMap(h => gateways[inC].flatMap(x => gateways[outC].flatMap(y => blockPairs.map(([o, r]) => ({
      legs: [leg(h, x, o), leg(y, h, r)],
      row: { kind: 'OJ', from: h, to: x, from2: y, to2: h },
      label: `${h} → ${x} … ${y} → ${h}${datesLabel(o, r)}`,
    })))))));

  const oneWayTasks = gateways => {
    const airports = Object.values(gateways).flat();
    const outbound = homes.flatMap(h => airports.flatMap(x => outCenters.map(o => ({
      legs: [leg(h, x, o)],
      row: { kind: 'OW-out', from: h, to: x, from2: null, to2: null },
      label: `${h} → ${x} one-way${outCenters.length > 1 ? ` [${addDays(o, -3)}…${addDays(o, 3)}]` : ''}`,
    }))));
    const inbound = airports.flatMap(x => homes.flatMap(h => retCenters.map(r => ({
      legs: [leg(x, h, r)],
      row: { kind: 'OW-back', from: x, to: h, from2: null, to2: null },
      label: `${x} → ${h} one-way${retCenters.length > 1 ? ` [${addDays(r, -3)}…${addDays(r, 3)}]` : ''}`,
    }))));
    return [...outbound, ...inbound];
  };

  // ---------- plan ----------
  const plannedGateways = Object.fromEntries(Object.entries(CONFIG.destinations).map(([c, a]) => [c, a.slice(0, CONFIG.gatewaysPerCountry)]));
  const planned = (CONFIG.searchRoundTrips ? roundTripTasks().length : 0)
    + (CONFIG.searchOpenJaw ? openJawTasks(plannedGateways).length : 0)
    + (CONFIG.searchOneWays ? oneWayTasks(plannedGateways).length : 0);
  const avgSeconds = (CONFIG.delayMs[0] + CONFIG.delayMs[1]) / 2000 + 1.5;
  console.log(`%cDelta fare finder: up to ${planned} searches (~${Math.ceil((planned * avgSeconds) / 60)} min if none are cached). `
    + `Departing ${CONFIG.departDates.join('–')}, returning ${CONFIG.returnDates.join('–')}, `
    + `${homes.join('/')} → ${allDestinations.join('/')}.`, 'font-weight:bold;font-size:13px');
  if (planned > CONFIG.maxRequests) {
    console.error(`That's more than maxRequests (${CONFIG.maxRequests}). Narrow the dates/airports or raise maxRequests.`);
    return;
  }
  if (CONFIG.departDates[0] < isoDay(Date.now())) console.warn('departDates starts in the past; those dates will come back empty.');

  window.DELTA_FARE_STOP = false; // clear a stop left over from an earlier run
  let haltedBy = null;
  try {
    if (CONFIG.searchRoundTrips) await runTasks('Round trips', roundTripTasks());
    const gateways = pickGateways();
    if (CONFIG.searchOpenJaw && tripCountries.length > 1) {
      console.log(`Open-jaw gateways: ${JSON.stringify(gateways)}`);
      await runTasks('Open-jaw', openJawTasks(gateways), { bailIfUnsupported: true });
    }
    if (CONFIG.searchOneWays) await runTasks('One-ways', oneWayTasks(gateways));
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    haltedBy = e.message;
    console.warn(`Stopped early: ${e.message}. Ranking what was found so far; re-run later to continue (finished searches are cached).`);
  }

  // ---------- rank ----------
  // Hops between countries once in Europe: the trip starts in the arrival airport's
  // country, must pass through every country in visitCountries, and ends in the
  // departure airport's country.
  function hopsNeeded(inCountry, outCountry) {
    const countries = new Set([...tripCountries, inCountry, outCountry]);
    if (inCountry !== outCountry) return countries.size - 1;
    return countries.size > 1 ? countries.size : 0;
  }

  const datesOk = (out, ret) => inRange(out, CONFIG.departDates) && inRange(ret, CONFIG.returnDates)
    && nightsBetween(out, ret) >= CONFIG.minNights && nightsBetween(out, ret) <= CONFIG.maxNights;

  function makeTrip(strategy, from, to, from2, to2, out, ret, airfare, stops) {
    const hops = hopsNeeded(countryOf[to], countryOf[from2]);
    const homeCost = ((CONFIG.homeAirportExtraCost[from] || 0) + (CONFIG.homeAirportExtraCost[to2] || 0)) / 2;
    return {
      strategy,
      route: from === to2 && to === from2 ? `${from} ⇄ ${to}` : `${from} → ${to} … ${from2} → ${to2}`,
      from, to, from2, to2, out, ret,
      nights: nightsBetween(out, ret),
      stops,
      airfare,
      hops,
      total: airfare + hops * CONFIG.hopCost * CONFIG.adults + homeCost,
    };
  }

  const trips = [];
  for (const r of rows) {
    if ((r.kind === 'RT' || r.kind === 'OJ') && datesOk(r.out, r.ret)) {
      trips.push(makeTrip(r.kind === 'RT' ? 'Round trip' : 'Open-jaw', r.from, r.to, r.from2, r.to2, r.out, r.ret, r.price, String(r.stops ?? '?')));
    }
  }
  const outbound = rows.filter(r => r.kind === 'OW-out');
  const inbound = rows.filter(r => r.kind === 'OW-back');
  for (const a of outbound) {
    for (const b of inbound) {
      if ((CONFIG.mixHomeAirports || b.to === a.from) && datesOk(a.out, b.out)) {
        trips.push(makeTrip('Two one-ways', a.from, a.to, b.from, b.to, a.out, b.out, a.price + b.price, `${a.stops ?? '?'}+${b.stops ?? '?'}`));
      }
    }
  }
  trips.sort((a, b) => a.total - b.total || a.airfare - b.airfare);

  // Best dates per route, cheapest first.
  const seen = new Set();
  const bestPerRoute = trips.filter(t => {
    const key = [t.strategy, t.from, t.to, t.from2, t.to2].join('|');
    return !seen.has(key) && seen.add(key);
  });

  const howToBook = t => {
    if (t.strategy === 'Round trip') return `Round Trip ${t.from} → ${t.to}, depart ${t.out}, return ${t.ret}`;
    if (t.strategy === 'Open-jaw') return `Multi-City: ${t.from} → ${t.to} on ${t.out}, then ${t.from2} → ${t.to2} on ${t.ret}`;
    return `Two One-Way tickets: ${t.from} → ${t.to} on ${t.out}, and ${t.from2} → ${t.to2} on ${t.ret}`;
  };
  const display = t => ({
    strategy: t.strategy,
    route: t.route,
    depart: t.out,
    return: t.ret,
    nights: t.nights,
    stops: t.stops,
    airfare: money(t.airfare),
    'Europe hops': t.hops,
    'est. total': money(t.total),
  });

  console.log(`%cDone: ${requests} searches sent, ${rows.length} fares, ${trips.length} trip options.${haltedBy ? ' (partial)' : ''}`, 'font-weight:bold;font-size:13px');
  if (!trips.length) {
    console.warn('No fares matched. Check the dates (future, within the ranges) and the nights limits.');
    return;
  }

  console.log(`%cCheapest by strategy (est. total includes ${money(CONFIG.hopCost)} per person per hop between ${tripCountries.join(' and ')}):`, 'font-weight:bold');
  console.table(bestPerRoute.filter((t, i, all) => all.findIndex(x => x.strategy === t.strategy) === i).map(display));

  console.log(`%cTop ${CONFIG.showTop} routes (best dates for each):`, 'font-weight:bold');
  console.table(bestPerRoute.slice(0, CONFIG.showTop).map(display));

  const matrix = {};
  for (const h of homes) {
    matrix[h] = {};
    for (const d of allDestinations) {
      const best = trips.find(t => t.strategy === 'Round trip' && t.from === h && t.to === d);
      matrix[h][d] = best ? money(best.airfare) : '—';
    }
  }
  if (trips.some(t => t.strategy === 'Round trip')) {
    console.log('%cCheapest round-trip airfare, home airport × destination:', 'font-weight:bold');
    console.table(matrix);
  }

  console.log('%cHow to book the top 5 on delta.com:', 'font-weight:bold');
  bestPerRoute.slice(0, 5).forEach((t, i) => console.log(`${i + 1}. ${money(t.total)} est. (${money(t.airfare)} airfare): ${howToBook(t)}`));
  console.log('Prices are for the whole party, before seat/bag fees, and can change by the minute. Search the exact dates on delta.com to confirm.');

  const csvCell = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const columns = ['strategy', 'route', 'from', 'to', 'from2', 'to2', 'out', 'ret', 'nights', 'stops', 'airfare', 'hops', 'total'];
  const csv = [columns.join(','), ...trips.map(t => columns.map(c => csvCell(t[c])).join(','))].join('\n');

  window.deltaFares = { config: CONFIG, currency, rows, trips, bestPerRoute, csv };
  console.log('Everything is in window.deltaFares (rows = raw fares, trips = every combination, bestPerRoute = table above).');

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
    save(`delta-trips-${stamp}.csv`, csv, 'text/csv');
    // Raw fares, for the Colab notebook's "analyze a console export" section.
    save(`delta-fares-${stamp}.json`, JSON.stringify({ config: CONFIG, currency, rows }), 'application/json');
  }
})();
