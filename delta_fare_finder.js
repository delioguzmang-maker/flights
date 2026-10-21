/*
 * Delta fare finder — DevTools console script
 *
 * delta.com's "My dates are flexible" grid only prices one origin → one destination
 * at a time. This script asks the same API for every home airport × European airport,
 * then ranks round trips, open-jaw (multi-city) trips and pairs of one-way tickets by
 * what the whole trip costs, including getting between countries once you're in Europe.
 *
 * Every trip's estimated total includes the drive to the airport and back and parking for
 * the whole trip (set up for Columbia, SC; edit CONFIG.drive for where you live).
 *
 * Beyond your own airports and dates it also checks, by default:
 *   - more airports: smaller German/Italian airports and cheap hubs elsewhere in Europe
 *     (Amsterdam, Paris, Madrid, …) that you'd continue from by train or budget flight;
 *   - airports Delta itself lists within 100 miles of your best routes (experimental);
 *   - more home airports you could drive to (Atlanta is Delta's hub, Augusta, Savannah…);
 *   - earlier and later weeks for the cheapest routes, in case moving the trip saves money.
 *
 * HOW TO RUN
 *   1. Open https://www.delta.com in Chrome or Edge (any page, logged in or not).
 *   2. Open DevTools (F12, or Cmd+Option+J on a Mac) and pick the Console tab.
 *   3. Change CONFIG below if you want (dates, airports), paste this whole file and press
 *      Enter. Chrome may first ask you to type "allow pasting".
 *   4. Leave the tab open. Progress prints as it goes (the default plan is ~250 searches,
 *      about 14–16 minutes). Results print as tables and download as CSV + JSON.
 *
 * Stop early:  window.DELTA_FARE_STOP = true   (the results so far are still ranked)
 * Re-running is cheap: grids fetched in the last few hours are reused from localStorage,
 * so you can tweak hopCost, nights or airports and run again.
 * Override settings without editing:  window.DELTA_FARE_CONFIG = { hopCost: 60 }  then paste.
 */
(async () => {
  'use strict';

  const CONFIG = {
    // Airports you can leave from and come home to, searched for every route.
    homeAirports: ['CAE', 'CLT', 'GSP', 'CHS'],

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

    // European airports to price, grouped by country.
    destinations: {
      Germany: ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR'],
      Italy: ['FCO', 'MXP', 'VCE', 'NAP', 'BLQ', 'FLR'],
    },
    // Countries the trip has to include, and your estimate (per person) for one
    // train / budget-airline hop between them. A round trip into Germany needs two hops
    // (Germany → Italy → back to Germany); flying into Germany and home from Italy needs one.
    // Flying into a third country (say Amsterdam) counts as one more place to travel through.
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
    // from the round-trip scans, to keep the number of searches down.
    gatewaysPerCountry: 3,
    // Let one-way pairs leave from one home airport and return to another.
    mixHomeAirports: false,

    // ----- other possibilities (set any of these to false / {} / [] to skip) -----
    // The exploring phases below search only from your N cheapest home airports
    // (ranked by airfare plus drive and parking).
    exploreFromTopHomes: 2,
    // More places to fly into, grouped by country. Airports in a visitCountries country
    // count as that country; anything else adds a hop (you'd take a train/budget flight on).
    moreAirports: {
      Germany: ['NUE', 'CGN', 'LEJ', 'HAJ'],
      Italy: ['PSA', 'LIN', 'TRN', 'BRI', 'CTA'],
      Netherlands: ['AMS'],
      France: ['CDG'],
      Spain: ['MAD', 'BCN'],
      Switzerland: ['ZRH'],
      Austria: ['VIE'],
      Ireland: ['DUB'],
      Portugal: ['LIS'],
    },
    // Ask Delta which airports lie within 100 miles of your best routes, both ends (experimental).
    searchNearbyAirports: true,
    // Farther airports to try against the best European airports (their drive and parking
    // costs come from drive.airports).
    extraHomeAirports: ['ATL', 'AGS', 'SAV', 'MYR', 'AVL', 'RDU'],
    // Re-check the cheapest routes with the whole trip moved earlier or later by these many weeks.
    otherWeeks: { routes: 5, shifts: [-3, -2, -1, 1, 2, 3] },

    delayMs: [1200, 2500], // pause between searches; keep it polite or Delta may block you for a while
    maxRequests: 500,
    cacheHours: 6,
    showTop: 25,
    download: true,
  };
  // Settings in window.DELTA_FARE_CONFIG win. drive is merged, so { drive: { dropOff: true } }
  // keeps the airport table; drive: false turns drive and parking costs off.
  const overrides = window.DELTA_FARE_CONFIG || {};
  const defaultDrive = CONFIG.drive;
  Object.assign(CONFIG, overrides);
  if (overrides.drive === false || overrides.drive === null) CONFIG.drive = { airports: {} };
  else if (overrides.drive) CONFIG.drive = { ...defaultDrive, ...overrides.drive, airports: { ...defaultDrive.airports, ...(overrides.drive.airports || {}) } };

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

  // The nearby-airports query delta.com sends, verbatim.
  const AIRPORTS_QUERY = `query ($offerSearchCriteria: OfferSearchCriteriaInput!) {
  gqlSearchOffers(offerSearchCriteria: $offerSearchCriteria) {
    offerResponseId
    gqlOffersSets {
      originAirportCode
      offers {
        soldOut
        offerPricing {
          totalAmt {
            currencyEquivalentPrice {
              roundedCurrencyAmt
              formattedCurrencyAmt
            }
            milesEquivalentPrice {
              mileCnt
            }
          }
        }
        additionalOfferProperties {
          lowestFare
          offered
          discountAvailable
        }
      }
    }
    offerDataList {
      flexDestinationAirportCodes
      pricingOptions {
        pricingOptionDetail {
          currencyCode
        }
      }
      responseProperties {
        tripTypeText
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
  const addCountry = (country, airports) => { for (const a of airports) countryOf[a] = countryOf[a] || country; };
  for (const [country, airports] of Object.entries(CONFIG.destinations)) addCountry(country, airports);
  for (const [country, airports] of Object.entries(CONFIG.moreAirports || {})) addCountry(country, airports);
  const allDestinations = Object.values(CONFIG.destinations).flat();
  const moreDestinations = [...new Set(Object.values(CONFIG.moreAirports || {}).flat())].filter(a => !allDestinations.includes(a));
  const homes = CONFIG.homeAirports;
  const extraHomes = (Array.isArray(CONFIG.extraHomeAirports) ? CONFIG.extraHomeAirports : Object.keys(CONFIG.extraHomeAirports || {}))
    .filter(a => !homes.includes(a));
  const knownCountries = new Set([...Object.keys(CONFIG.destinations), ...Object.keys(CONFIG.moreAirports || {})]);
  for (const c of CONFIG.visitCountries) {
    if (!knownCountries.has(c)) console.warn(`visitCountries lists ${c}, but no airport in destinations or moreAirports is there; leaving it out of the hop count.`);
  }
  const tripCountries = CONFIG.visitCountries.filter(c => knownCountries.has(c));
  const discovered = new Set(); // European airports found by the nearby-airports search
  const otherOrigins = {}; // home-side airports it found that aren't in your lists: code → best fare

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

  // ---------- API ----------
  // Flexible-dates leg: the API answers with a 7×7 grid around the date sent.
  const leg = (from, to, center) => ({
    departureLocalTs: `${center}T00:00:00`,
    destinations: [{ airportCode: to }],
    origins: [{ airportCode: from }],
    calenderDateRequest: { daysBeforeCnt: 3, daysAfterCnt: 3 }, // Delta's spelling
  });
  // Nearby-airports leg: exact date, and every airport within 100 miles of each end.
  const RADIUS = { unitOfMeasure: 'MI', unitOfMeasureCnt: 100 };
  const nearbyLeg = (from, to, date) => ({
    departureLocalTs: `${date}T00:00:00`,
    destinations: [{ airportCode: to, airportRadiusMileCnt: RADIUS }],
    origins: [{ airportCode: from, airportRadiusMileCnt: RADIUS }],
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
  // Same headers delta.com sends for a guest search. x-app-route is 'dates' for the
  // flexible-dates grid and 'airport' for the nearby-airports grid.
  const offerHeaders = route => ({
    Authorization: 'GUEST',
    'Content-Type': 'application/json',
    TransactionId: `${transactionPrefix}_${Date.now()}`,
    applicationId: 'DC',
    'x-app-type': 'dcom-shop',
    'x-app-route': route,
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
  // Nearby-airports grid, read the way delta.com does: one offer set per origin airport
  // (originAirportCode), its offers lining up with offerDataList.flexDestinationAirportCodes.
  function parseAirports(offers) {
    const props = offers.offerDataList || {};
    currency = props.pricingOptions?.[0]?.pricingOptionDetail?.currencyCode || currency;
    const destinations = props.flexDestinationAirportCodes || [];
    const cells = [];
    for (const set of offers.gqlOffersSets || []) {
      (set.offers || []).forEach((offer, j) => {
        const p = offer.additionalOfferProperties || {};
        const amount = offer.offerPricing?.[0]?.totalAmt?.currencyEquivalentPrice || {};
        const price = parseFloat(String(amount.formattedCurrencyAmt ?? '').replace(/,/g, '')) || amount.roundedCurrencyAmt;
        if (!price || offer.soldOut || p.offered === false || !set.originAirportCode || !destinations[j]) return;
        cells.push([set.originAirportCode, destinations[j], price]);
      });
    }
    return cells;
  }

  const MODES = {
    dates: { query: QUERY, parse: parseGrid },
    airport: { query: AIRPORTS_QUERY, parse: parseAirports },
  };

  async function fetchOffers(mode, legs) {
    let json = await http(OFFERS_URL, {
      method: 'POST',
      credentials: 'include',
      headers: offerHeaders(mode),
      body: JSON.stringify({ variables: { offerSearchCriteria: searchCriteria(legs) }, query: MODES[mode].query }),
    });
    for (let polls = 0; ; polls++) {
      const offers = json?.data?.gqlSearchOffers;
      if (offers) return { cells: MODES[mode].parse(offers) };
      const err = errorInfo(json?.errors?.[0]);
      // Errors with a Delta code (e.g. ROF4002_404: no service) are answers worth caching;
      // anything else (HTTP 500, a bare GraphQL error, an empty body) may work next time.
      if (err.code !== CALLBACK_CODE || !err.callbackId) return { cells: [], error: err.code || err.message || 'empty response', transient: !err.code };
      if (polls === 10) return { cells: [], error: 'gave up waiting for callback', transient: true, timedOut: true };
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
  let failuresInARow = 0;
  async function request(mode, legs) {
    // Dates-grid keys keep the format of earlier versions, so their cache still counts.
    const key = JSON.stringify(mode === 'dates'
      ? [legs, CONFIG.adults, CONFIG.brand, CONFIG.nonStopOnly]
      : [mode, legs, CONFIG.adults, CONFIG.brand, CONFIG.nonStopOnly]);
    if (cache[key]) return { ...cache[key], cached: true };
    if (window.DELTA_FARE_STOP) throw new Halt('stopped by DELTA_FARE_STOP');
    if (requests >= CONFIG.maxRequests) throw new Halt(`reached maxRequests (${CONFIG.maxRequests})`);
    if (requests > 0) await sleep(CONFIG.delayMs[0] + Math.random() * (CONFIG.delayMs[1] - CONFIG.delayMs[0]));
    requests++;
    const result = await fetchOffers(mode, legs);
    if (result.transient) {
      failuresInARow++;
    } else {
      failuresInARow = 0;
      cache[key] = { t: Date.now(), currency, cells: result.cells, error: result.error };
      saveCache();
    }
    return result;
  }

  // ---------- trips ----------
  const inDates = (out, ret) => inRange(out, CONFIG.departDates) && ret != null && inRange(ret, CONFIG.returnDates);
  const nightsOk = (out, ret) => nightsBetween(out, ret) >= CONFIG.minNights && nightsBetween(out, ret) <= CONFIG.maxNights;

  // Hops between countries once in Europe: the trip starts in the arrival airport's
  // country, must pass through every country in visitCountries, and ends in the
  // departure airport's country.
  function hopsNeeded(inCountry, outCountry) {
    const countries = new Set([...tripCountries, inCountry, outCountry]);
    if (inCountry !== outCountry) return countries.size - 1;
    return countries.size > 1 ? countries.size : 0;
  }

  function makeTrip(strategy, from, to, from2, to2, out, ret, airfare, stops) {
    const hops = hopsNeeded(countryOf[to], countryOf[from2]);
    const nights = nightsBetween(out, ret);
    // Leaving from one airport and coming home to another (mixHomeAirports): average the two.
    const ground = (groundCost(from, nights) + groundCost(to2, nights)) / 2;
    return {
      strategy,
      route: from === to2 && to === from2 ? `${from} ⇄ ${to}` : `${from} → ${to} … ${from2} → ${to2}`,
      from, to, from2, to2, out, ret,
      nights,
      stops,
      airfare,
      hops,
      driveAndPark: ground,
      total: airfare + hops * CONFIG.hopCost * CONFIG.adults + ground,
      yourDates: inDates(out, ret),
    };
  }

  // Every trip the fares found so far make: round trips and open-jaws on any searched dates,
  // and one-way pairs on your dates. Cheapest est. total first.
  function buildTrips() {
    const trips = [];
    for (const r of rows) {
      if ((r.kind === 'RT' || r.kind === 'OJ') && r.ret && nightsOk(r.out, r.ret)) {
        trips.push(makeTrip(r.kind === 'RT' ? 'Round trip' : 'Open-jaw', r.from, r.to, r.from2, r.to2, r.out, r.ret, r.price, String(r.stops ?? '?')));
      }
    }
    const outbound = rows.filter(r => r.kind === 'OW-out');
    const inbound = rows.filter(r => r.kind === 'OW-back');
    for (const a of outbound) {
      for (const b of inbound) {
        if ((CONFIG.mixHomeAirports || b.to === a.from) && inDates(a.out, b.out) && nightsOk(a.out, b.out)) {
          trips.push(makeTrip('Two one-ways', a.from, a.to, b.from, b.to, a.out, b.out, a.price + b.price, `${a.stops ?? '?'}+${b.stops ?? '?'}`));
        }
      }
    }
    return trips.sort((a, b) => a.total - b.total || a.airfare - b.airfare);
  }

  // Best dates per route, cheapest first.
  const bestPerRoute = trips => {
    const seen = new Set();
    return trips.filter(t => {
      const key = [t.strategy, t.from, t.to, t.from2, t.to2].join('|');
      return !seen.has(key) && seen.add(key);
    });
  };

  // ---------- searches ----------
  const rows = [];

  async function runTasks(name, tasks, { mode = 'dates', bailIfUnsupported = false } = {}) {
    if (!tasks.length) return true;
    console.log(`%c${name}: ${tasks.length} searches`, 'font-weight:bold');
    for (const [n, task] of tasks.entries()) {
      const result = await request(mode, task.legs);
      if (result.cached && result.currency) currency = result.currency;
      task.result = result;
      const added = task.collect(result.cells);
      const best = added.length ? Math.min(...added.map(r => r.price)) : null;
      const outcome = best != null ? `from ${money(best)}${task.describe ? task.describe(added) : ''}` : `no fares${result.error ? ` (${result.error})` : ''}`;
      console.log(`[${name} ${n + 1}/${tasks.length}] ${task.label}: ${outcome}${result.cached ? ' (cached)' : ''}`);
      // A phase whose first 3 searches all fail (time-outs aside) isn't offered: skip it.
      const probe = Math.min(2, tasks.length - 1);
      if (bailIfUnsupported && n === probe && tasks.slice(0, probe + 1).every(t => t.result.error && !t.result.timedOut)) {
        console.warn(`${name}: the first ${probe + 1} searches all failed, so Delta's API probably doesn't offer these. Skipping the rest.`);
        failuresInARow = 0;
        return false;
      }
      if (failuresInARow >= 5) {
        throw new Halt(`the last 5 searches failed (now in "${name}"); Delta may be blocking this browser for now. Wait a while and re-run`);
      }
    }
    return true;
  }

  // A flexible-dates search whose 7×7 grid becomes rows of the given kind and airports.
  const gridTask = (row, legs, label) => ({
    legs,
    label,
    collect: cells => cells.map(([out, ret, price, stops]) => {
      const r = { ...row, out, ret, price, stops };
      rows.push(r);
      return r;
    }),
  });
  const shiftLabel = ([o, r]) => (blockPairs.length > 1 ? ` [${addDays(o, -3)}…${addDays(o, 3)} / ${addDays(r, -3)}…${addDays(r, 3)}]` : '');
  const roundTrip = (h, d, pair, suffix = shiftLabel(pair)) => gridTask(
    { kind: 'RT', from: h, to: d, from2: d, to2: h }, [leg(h, d, pair[0]), leg(d, h, pair[1])], `${h} ⇄ ${d}${suffix}`);
  const openJaw = (h, x, y, pair, suffix = shiftLabel(pair)) => gridTask(
    { kind: 'OJ', from: h, to: x, from2: y, to2: h }, [leg(h, x, pair[0]), leg(y, h, pair[1])], `${h} → ${x} … ${y} → ${h}${suffix}`);

  const usable = r => r.kind === 'RT' && inDates(r.out, r.ret) && nightsOk(r.out, r.ret);
  // Your N cheapest home airports by airfare plus drive and parking (all of them if nothing
  // is priced yet).
  function topHomes() {
    const best = {};
    for (const r of rows) {
      if (usable(r) && homes.includes(r.from)) best[r.from] = Math.min(best[r.from] ?? Infinity, r.price + groundCost(r.from, nightsBetween(r.out, r.ret)));
    }
    const ranked = homes.filter(h => best[h] != null).sort((a, b) => best[a] - best[b]);
    return (ranked.length ? ranked : homes).slice(0, Math.max(1, CONFIG.exploreFromTopHomes || homes.length));
  }
  // The N cheapest airports per visit country so far. Until one of your main destinations
  // there has a price (e.g. round trips are switched off), use the first N main destinations.
  function pickGateways() {
    const best = {};
    for (const r of rows) if (usable(r)) best[r.to] = Math.min(best[r.to] ?? Infinity, r.price);
    const picked = {};
    for (const country of tripCountries) {
      const main = CONFIG.destinations[country] || [];
      const pool = main.some(a => best[a] != null) || !main.length ? Object.keys(countryOf).filter(a => countryOf[a] === country) : main;
      const priced = pool.filter(a => best[a] != null).sort((a, b) => best[a] - best[b]);
      picked[country] = (priced.length ? priced : main).slice(0, CONFIG.gatewaysPerCountry);
    }
    return picked;
  }

  const roundTripTasks = (fromList, toList) => fromList.flatMap(h => toList.flatMap(d => blockPairs.map(p => roundTrip(h, d, p))));

  const openJawTasks = gateways => tripCountries.flatMap(inC => tripCountries.filter(c => c !== inC).flatMap(outC =>
    homes.flatMap(h => gateways[inC].flatMap(x => gateways[outC].flatMap(y => blockPairs.map(p => openJaw(h, x, y, p)))))));

  const oneWayTasks = (fromList, gateways) => {
    const airports = Object.values(gateways).flat();
    const outbound = fromList.flatMap(h => airports.flatMap(x => outCenters.map(o => gridTask(
      { kind: 'OW-out', from: h, to: x, from2: null, to2: null }, [leg(h, x, o)],
      `${h} → ${x} one-way${outCenters.length > 1 ? ` [${addDays(o, -3)}…${addDays(o, 3)}]` : ''}`))));
    const inbound = airports.flatMap(x => fromList.flatMap(h => retCenters.map(r => gridTask(
      { kind: 'OW-back', from: x, to: h, from2: null, to2: null }, [leg(x, h, r)],
      `${x} → ${h} one-way${retCenters.length > 1 ? ` [${addDays(r, -3)}…${addDays(r, 3)}]` : ''}`))));
    return [...outbound, ...inbound];
  };

  // Delta's own nearby-airports search around each top home airport and the cheapest
  // airport of each visit country, on that round trip's best dates.
  function nearbyTasks(fromList) {
    const tasks = [];
    for (const country of tripCountries) {
      for (const h of fromList) {
        let best = null;
        for (const r of rows) {
          if (usable(r) && r.from === h && countryOf[r.to] === country && (!best || r.price < best.price)) best = r;
        }
        if (!best) continue;
        tasks.push({
          legs: [nearbyLeg(h, best.to, best.out), nearbyLeg(best.to, h, best.ret)],
          label: `airports near ${h} ⇄ ${best.to}, ${best.out} → ${best.ret}`,
          collect: cells => cells.map(([from, to, price]) => {
            if (!countryOf[to]) {
              countryOf[to] = country; // close enough: it is within 100 miles of an airport there
              discovered.add(to);
            }
            // A home-side airport you haven't listed has no drive cost to compare fairly, so
            // it's only reported, not ranked.
            if (!homes.includes(from) && !extraHomes.includes(from)) {
              if (!otherOrigins[from] || price < otherOrigins[from].price) otherOrigins[from] = { to, price, out: best.out, ret: best.ret };
              return null;
            }
            const r = { kind: 'RT', from, to, from2: to, to2: from, out: best.out, ret: best.ret, price, stops: null };
            rows.push(r);
            return r;
          }).filter(Boolean),
          describe: added => ` (${[...new Set(added.map(r => r.from))].join('/')} → ${[...new Set(added.map(r => r.to))].join('/')})`,
        });
      }
    }
    return tasks;
  }

  // The same trip moved earlier or later by whole weeks, for the cheapest routes on your dates.
  // Each shifted search is the searched 7×7 block that held the route's best fare, moved by
  // whole weeks, so the shifted blocks sit next to it with no gap and no overlap.
  function otherWeekTasks() {
    const shifts = (CONFIG.otherWeeks && CONFIG.otherWeeks.shifts) || [];
    const searched = new Set(blockPairs.map(p => p.join('|')));
    const best = bestPerRoute(buildTrips().filter(t => t.yourDates && t.strategy !== 'Two one-ways')).slice(0, CONFIG.otherWeeks.routes || 0);
    return best.flatMap(t => {
      const base = blockPairs.find(([o, r]) => Math.abs(nightsBetween(o, t.out)) <= 3 && Math.abs(nightsBetween(r, t.ret)) <= 3) || [t.out, t.ret];
      return shifts
        .map(k => [k, [addDays(base[0], 7 * k), addDays(base[1], 7 * k)]])
        .filter(([, pair]) => !searched.has(pair.join('|')))
        .map(([k, pair]) => {
          const suffix = ` [${k > 0 ? '+' : ''}${k} wk: ${addDays(pair[0], -3)}…${addDays(pair[0], 3)} / ${addDays(pair[1], -3)}…${addDays(pair[1], 3)}]`;
          return t.strategy === 'Round trip' ? roundTrip(t.from, t.to, pair, suffix) : openJaw(t.from, t.to, t.from2, pair, suffix);
        });
    }).filter(task => task.legs[0].departureLocalTs.slice(0, 10) > isoDay(Date.now() + 3 * DAY));
  }

  // ---------- plan ----------
  // Upper bound for the estimate: gateways can also come from moreAirports and nearby finds.
  const plannedGateways = Object.fromEntries(tripCountries.map(c => {
    const pool = Object.keys(countryOf).filter(a => countryOf[a] === c).length;
    const n = CONFIG.searchNearbyAirports ? CONFIG.gatewaysPerCountry : Math.min(CONFIG.gatewaysPerCountry, pool);
    return [c, Array.from({ length: n }, (_, i) => `${c}${i}`)];
  }));
  const exploreHomes = homes.slice(0, Math.max(1, CONFIG.exploreFromTopHomes || homes.length));
  const plan = {
    'Round trips': CONFIG.searchRoundTrips ? roundTripTasks(homes, allDestinations).length : 0,
    'More airports': roundTripTasks(exploreHomes, moreDestinations).length,
    'Nearby airports': CONFIG.searchNearbyAirports ? exploreHomes.length * tripCountries.length : 0,
    'Open-jaw': CONFIG.searchOpenJaw && tripCountries.length > 1 ? openJawTasks(plannedGateways).length : 0,
    'One-ways': CONFIG.searchOneWays ? oneWayTasks(exploreHomes, plannedGateways).length : 0,
    'More home airports': roundTripTasks(extraHomes, Object.values(plannedGateways).flat()).length,
    'Other weeks': CONFIG.otherWeeks ? (CONFIG.otherWeeks.routes || 0) * ((CONFIG.otherWeeks.shifts || []).length) : 0,
  };
  const planned = Object.values(plan).reduce((a, b) => a + b, 0);
  const avgSeconds = (CONFIG.delayMs[0] + CONFIG.delayMs[1]) / 2000 + 1.5;
  console.log(`%cDelta fare finder: up to ${planned} searches (~${Math.ceil((planned * avgSeconds) / 60)} min if none are cached). `
    + `Departing ${CONFIG.departDates.join('–')}, returning ${CONFIG.returnDates.join('–')}, `
    + `${homes.join('/')} → ${allDestinations.join('/')}.`, 'font-weight:bold;font-size:13px');
  console.log(Object.entries(plan).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(' · '));
  if (planned > CONFIG.maxRequests) {
    console.error(`That's more than maxRequests (${CONFIG.maxRequests}). Narrow the dates/airports, turn off some of the extra searches, or raise maxRequests.`);
    return;
  }
  if (CONFIG.departDates[0] < isoDay(Date.now())) console.warn('departDates starts in the past; those dates will come back empty.');
  const noDriveData = [...homes, ...extraHomes].filter(a => !(CONFIG.drive?.airports || {})[a]);
  if (noDriveData.length && Object.keys(CONFIG.drive?.airports || {}).length) {
    console.warn(`No drive/parking figures for ${noDriveData.join(', ')}: their trips are ranked as if getting there were free. Add them to drive.airports.`);
  }
  const typicalNights = Math.max(0, nightsBetween(CONFIG.departDates[0], CONFIG.returnDates[0]));
  console.log(`Drive + parking for a ${typicalNights}-night trip: ${[...homes, ...extraHomes].map(a => `${a} ${money(groundCost(a, typicalNights))}`).join(' · ')}`);

  window.DELTA_FARE_STOP = false; // clear a stop left over from an earlier run
  let haltedBy = null;
  try {
    if (CONFIG.searchRoundTrips) await runTasks('Round trips', roundTripTasks(homes, allDestinations));
    const explore = topHomes();
    await runTasks('More airports', roundTripTasks(explore, moreDestinations));
    if (CONFIG.searchNearbyAirports) await runTasks('Nearby airports', nearbyTasks(explore), { mode: 'airport', bailIfUnsupported: true });
    const gateways = pickGateways();
    if (CONFIG.searchOpenJaw && tripCountries.length > 1) {
      console.log(`Open-jaw gateways: ${JSON.stringify(gateways)}`);
      await runTasks('Open-jaw', openJawTasks(gateways), { bailIfUnsupported: true });
    }
    if (CONFIG.searchOneWays) await runTasks('One-ways', oneWayTasks(explore, gateways));
    await runTasks('More home airports', roundTripTasks(extraHomes, Object.values(gateways).flat()));
    if (CONFIG.otherWeeks) await runTasks('Other weeks', otherWeekTasks());
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    haltedBy = e.message;
    console.warn(`Stopped early: ${e.message}. Ranking what was found so far; re-run later to continue (finished searches are cached).`);
  }

  // ---------- results ----------
  const trips = buildTrips();
  const onYourDates = trips.filter(t => t.yourDates);
  const best = bestPerRoute(onYourDates);

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
    'drive + park': money(t.driveAndPark),
    'Europe hops': t.hops,
    'est. total': money(t.total),
  });

  console.log(`%cDone: ${requests} searches sent, ${rows.length} fares, ${trips.length} trip options.${haltedBy ? ' (partial)' : ''}`, 'font-weight:bold;font-size:13px');
  if (!trips.length) {
    console.warn('No fares matched. Check the dates (future, within the ranges) and the nights limits.');
    return;
  }

  if (best.length) {
    console.log(`%cCheapest by strategy on your dates (est. total = airfare + drive & parking + ${money(CONFIG.hopCost)} per person per hop between ${tripCountries.join(' and ')}):`, 'font-weight:bold');
    console.table(best.filter((t, i, all) => all.findIndex(x => x.strategy === t.strategy) === i).map(display));

    console.log(`%cTop ${CONFIG.showTop} routes on your dates (best dates for each):`, 'font-weight:bold');
    console.table(best.slice(0, CONFIG.showTop).map(display));
  }

  // Other weeks: only moves that beat the best option on your dates.
  const yourBest = {};
  for (const t of best) yourBest[`${t.strategy}|${t.route}`] = t.total;
  const bestTotal = best.length ? best[0].total : Infinity;
  const otherDates = bestPerRoute(trips.filter(t => !t.yourDates)).filter(t => t.total < bestTotal).slice(0, 10);
  if (otherDates.length) {
    console.log('%cCheaper if you can move the trip:', 'font-weight:bold');
    console.table(otherDates.map(t => {
      const same = yourBest[`${t.strategy}|${t.route}`];
      return {
        ...display(t),
        'vs your best': bestTotal < Infinity ? `−${money(bestTotal - t.total)}` : '',
        'vs this route on your dates': same != null ? `−${money(same - t.total)}` : 'not priced',
      };
    }));
  }

  const airportsTable = {};
  for (const t of best) {
    if (t.strategy !== 'Round trip' || airportsTable[t.to]) continue;
    airportsTable[t.to] = {
      country: countryOf[t.to] || '',
      airfare: money(t.airfare),
      'est. total': money(t.total),
      from: t.from,
      dates: `${t.out} → ${t.ret}`,
      found: discovered.has(t.to) ? 'nearby search' : moreDestinations.includes(t.to) ? 'more airports' : '',
    };
  }
  if (Object.keys(airportsTable).length) {
    console.log('%cCheapest round trip to each European airport, on your dates:', 'font-weight:bold');
    console.table(airportsTable);
  }

  const matrix = {};
  for (const h of homes) {
    matrix[h] = {};
    for (const d of allDestinations) {
      const t = best.find(x => x.strategy === 'Round trip' && x.from === h && x.to === d);
      matrix[h][d] = t ? money(t.airfare) : '—';
    }
  }
  if (best.some(t => t.strategy === 'Round trip')) {
    console.log('%cCheapest round-trip airfare, home airport × destination:', 'font-weight:bold');
    console.table(matrix);
  }

  const byHome = [...homes, ...extraHomes].map(h => best.find(t => t.from === h)).filter(Boolean).sort((a, b) => a.total - b.total);
  if (byHome.length) {
    console.log('%cBest trip from each home airport, drive and parking included:', 'font-weight:bold');
    console.table(byHome.map(display));
  }
  if (discovered.size) console.log(`Delta's nearby-airports search also turned up these European airports: ${[...discovered].join(', ')}.`);
  const others = Object.entries(otherOrigins).sort((a, b) => a[1].price - b[1].price);
  if (others.length) {
    console.log(`It also lists these airports near yours (not ranked, no drive cost set): ${others.map(([a, o]) => `${a} ⇄ ${o.to} ${money(o.price)}`).join(', ')}. `
      + 'To compare one properly, add it to drive.airports (miles, parking) and extraHomeAirports.');
  }

  console.log('%cHow to book on delta.com:', 'font-weight:bold');
  best.slice(0, 5).forEach((t, i) => console.log(`${i + 1}. ${money(t.total)} est. (${money(t.airfare)} airfare): ${howToBook(t)}`));
  otherDates.slice(0, 3).forEach(t => console.log(`   other dates: ${money(t.total)} est. (${money(t.airfare)} airfare): ${howToBook(t)}`));
  console.log('Prices are for the whole party, before seat/bag fees, and can change by the minute. Search the exact dates on delta.com to confirm.');

  const csvCell = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const columns = ['strategy', 'route', 'from', 'to', 'from2', 'to2', 'out', 'ret', 'nights', 'stops', 'airfare', 'driveAndPark', 'hops', 'total', 'yourDates'];
  const csv = [columns.join(','), ...trips.map(t => columns.map(c => csvCell(t[c])).join(','))].join('\n');

  // Raw fares, for the Colab notebook's "analyze a console export" section.
  const exported = { config: CONFIG, currency, rows, countryOf };
  window.deltaFares = { config: CONFIG, currency, rows, trips, bestPerRoute: best, otherDates, discovered: [...discovered], otherOrigins, csv, export: exported };
  console.log('Everything is in window.deltaFares (rows = raw fares, trips = every combination, bestPerRoute = your-dates table).');

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
    console.log('Downloading delta-trips (CSV) and delta-fares (JSON). If the browser asks to allow multiple downloads, allow it. '
      + 'If the JSON doesn\'t arrive, type  copy(JSON.stringify(deltaFares.export))  here and paste it into a file.');
    save(`delta-trips-${stamp}.csv`, csv, 'text/csv');
    save(`delta-fares-${stamp}.json`, JSON.stringify(exported), 'application/json');
  }
})();
