# Fare finders for delta.com and Google Flights

Two DevTools console scripts, one per site, plus a Colab notebook. They search every combination of nearby home airports (**CHS, CAE, GSP, CLT**) and European airports, and rank the ways of doing a two-country trip (e.g. Germany + Italy):

| Strategy | Example | Getting between countries |
|---|---|---|
| **Round trip** | CLT ⇄ MXP | 2 hops (Italy → Germany → back to Italy) |
| **Open-jaw** (multi-city) | CLT → MUC … FCO → CLT | 1 hop (Germany → Italy) |
| **Two one-ways** | CLT → MUC, FCO → CLT as separate tickets | 1 hop |

Each option is ranked by **estimated total = airfare + hops × `hopCost` + any home-airport cost you set**. Use `hopCost` for what one train or budget-airline ticket between the countries costs you (Munich ↔ Milan/Venice by FlixBus/train or Ryanair/easyJet is often $30–100). That way "round trip + 2 hops" is compared fairly with "open-jaw + 1 hop".

| | [`delta_fare_finder.js`](delta_fare_finder.js) | [`google_flights_finder.js`](google_flights_finder.js) |
|---|---|---|
| Run it on | a delta.com tab | a google.com/travel/flights tab |
| Airlines | Delta and partners (Air France, KLM, Virgin, ITA…) | Every airline Google Flights shows (American from CLT, United, Lufthansa, budget carriers…) |
| One search covers | one home airport → one European airport, 7 × 7 departure/return dates | all home airports → up to 7 European airports, one date pair |
| Multi-city prices | yes | no (Google only prices these inside its own page code); it prints ready-made multi-city links to check by hand |
| Default plan | ~240 searches, ~14 min | ~90 searches, ~10 min |

Run both: Delta's grid is the fastest way to sweep dates, and Google catches cheaper airlines Delta doesn't sell.

## What your first Delta run showed

From the 12,936 trip options in your `trips-2026-10-09` CSV:

- **Cheapest:** round trip **CLT ⇄ MXP, Dec 14 → Dec 22, $788** airfare ($938 with two $75 hops). Best open-jaw: CLT → NAP … BER → CLT, $869 ($944 with one hop). Best one-way pair: $998.
- **Open-jaw costs about one hop more than a round trip** (~$80), so the two come out even. Pick whichever routing suits the itinerary.
- **Italy is much cheaper than Germany to fly into:** $788 vs $1,015 cheapest round trip. Open-jaw into Italy and home from Germany beat the reverse.
- **Prices climb steeply towards Christmas.** The typical (median) route's cheapest fare is $1,042 departing Dec 14, $1,301 on Dec 17 and $1,777 on Dec 18. Every best fare departs Dec 14, the first day searched, so **earlier weeks are likely cheaper still.** Returning by Dec 25 ($788–803) is cheaper than after Christmas ($905).
- **Your four home airports are within $10 of each other** ($788–798), so drive to whichever is easiest.

The updated Delta script follows up on that: it searches earlier and later weeks for the best routes, more airports, and more home airports (below).

## delta.com script

1. Open <https://www.delta.com> in Chrome or Edge. Any page works, logged in or not.
2. Press **F12** (Mac: **Cmd+Option+J**) and open the **Console** tab.
3. Edit the `CONFIG` block at the top of [`delta_fare_finder.js`](delta_fare_finder.js) if you want. Copy the whole file, paste it into the console and press Enter. Chrome may first ask you to type `allow pasting`.
4. Leave the tab open while it runs. Progress prints line by line.

It searches in this order:

| Phase | Searches | What it's for |
|---|---|---|
| Round trips | 48 | every home airport ⇄ the 12 main airports in Germany and Italy |
| More airports | 34 | your 2 cheapest home airports ⇄ smaller German/Italian airports (NUE, CGN, LEJ, HAJ, PSA, LIN, TRN, BRI, CTA) and cheap hubs elsewhere (AMS, CDG, MAD, BCN, ZRH, VIE, DUB, LIS). A third country counts as one more hop. |
| Nearby airports | 4 | Delta's own "nearby airports" search (100 miles around both ends) on your best routes. It turns up airports nobody listed. Experimental: it skips itself if Delta rejects it. |
| Open-jaw | 72 | into one country, home from the other, via the 3 cheapest airports in each |
| One-ways | 24 | separate tickets from your 2 cheapest home airports |
| More home airports | 30 | ATL, SAV, MYR, AVL, RDU ⇄ the best airports, plus a drive/parking cost you set (`extraHomeAirports`, default ATL $100, SAV/MYR/AVL $50, RDU $90) |
| Other weeks | 30 | the 5 cheapest routes with the whole trip moved 1–3 weeks earlier or later |

When it finishes you get:

- **Cheapest by strategy** and the **top 25 routes** on your dates.
- **Cheaper if you can move the trip:** the shifted weeks that beat your dates, and by how much.
- **Cheapest round trip to each European airport**, including the extra and nearby airports.
- **Best trip from each other home airport**, with the extra cost included.
- The home airport × destination matrix, and **how to book** the best options on delta.com.
- Two downloads: `delta-trips-….csv` (every combination, with a `yourDates` column) and `delta-fares-….json` (raw fares, which the notebook can analyse). Everything is also in `window.deltaFares`.

Stop early with `window.DELTA_FARE_STOP = true`; what was found so far still gets ranked. Searches are cached in the browser for 6 hours, so a re-run, or a run right after your first one, skips what's already fetched. To skip a phase, set `moreAirports: {}`, `searchNearbyAirports: false`, `extraHomeAirports: {}` or `otherWeeks: false`. To change settings without editing the file, set e.g. `window.DELTA_FARE_CONFIG = { hopCost: 60 }` before pasting.

## Google Flights script

1. Open <https://www.google.com/travel/flights> in Chrome or Edge.
2. Open the Console as above, paste [`google_flights_finder.js`](google_flights_finder.js) and press Enter.

Each search asks Google for all four home airports at once against a group of up to 7 airports: Germany, Italy, and "Other hubs" (MAD, BCN, AMS, CDG, DUB, LIS, ZRH). It covers every departure (Dec 12–16) × return (Dec 21–24) pair, plus one-ways for each day. You get:

- **Cheapest by strategy** and the **top 25 routes**, with airline, stops and flight numbers.
- **A departure × return price grid**, to see which dates are cheapest.
- **Google's own "cheaper dates" suggestions** outside your ranges.
- **Multi-city links worth opening by hand.**
- **A Google Flights link for each result**, which opens that exact search so you can book it.

Downloads `google-trips-….csv` and `google-fares-….json`; everything is also in `window.googleFares`. Stop with `window.GF_FARE_STOP = true`.

Google is stricter about automated traffic than Delta. Keep `delayMs` at 3–6 seconds. If you see "Google wants to check you're not a robot", run a normal search in the tab, solve the check if shown, wait a few minutes and paste again. Finished searches are cached.

## Colab notebook

[`delta_fare_finder.ipynb`](delta_fare_finder.ipynb) runs the Delta search from Python. **Delta may refuse requests from cloud machines.** If it does, run the console script and upload its `delta-fares-….json` in step 5 to get the same tables as pandas DataFrames. The notebook handles the extra airports, nearby airports and extra home airports in the console script's exports.

Open it in Colab with **File → Upload notebook**, or **File → Open notebook → GitHub** (tick *Include private repos* if this repo is private).

## How it works

**delta.com** (from your first HAR capture)

- The flexible-dates grid is one GraphQL call: `POST https://offer-api-prd.delta.com/prd/rm-offer-gql` (`gqlSearchOffers`). Each leg carries `calenderDateRequest: {daysBeforeCnt: 3, daysAfterCnt: 3}`, and each call returns 7 × 7 outbound × return dates.
- The script sends what the site sends for a guest. The headers are `Authorization: GUEST`, which Chrome's HAR export strips, plus `applicationId: DC`, `channelId: DCOM`, `Airline: DL`, `x-app-type: dcom-shop`, `x-app-route: dates` and `TransactionId`, with cookies. The request body matches the capture byte for byte.
- Sometimes the API replies with error `ROF5004_PXY1007` and a `callbackId`. The script then polls `GET /prd/callback/{callbackId}`, as the site does.
- Grids are read the way delta.com's code reads them. In a round-trip grid, each offer set is an outbound date and its offers line up with `flexReturnDates`. In a one-way grid, the fare for set *i* is `offers[i]`.
- Your run confirmed that 2-leg multi-city grids work.
- The nearby-airports search is the site's "flexible airports" call: the same endpoint, `x-app-route: airport`, and `airportRadiusMileCnt: 100 MI` on both ends of every leg. Its request and response layout come from the site's code, not a capture, so it is marked experimental.
- delta.com also has a monthly price calendar (`calendarSearch: true`). It isn't used: how its return dates work is only inferred, and the week-shifted grids answer "is another week cheaper?" with a request format already proven by your run.

**Google Flights** (from your second HAR capture, a CHS/GSP/CLT/CAE → Madrid search)

- A search is addressed by the `tfs=` URL parameter, a small protobuf holding trip type, passengers, cabin and per-leg date and airports. The script's encoder reproduces your captured URL byte for byte.
- The results page embeds its flights in `AF_initDataCallback({key: 'ds:1', …})`. The script fetches that page for each search and reads the same itinerary rows the page shows: price, airlines, flight numbers, times, stops and layovers. It also reads Google's "cheaper dates" hint (your capture's hint: Dec 15–25 for $869 vs $1,304).
- Since August 2026, Google's internal endpoints (`GetShoppingResults`, `GetCalendarGraph`, …) require an `x-goog-batchexecute-bgr` anti-bot signature that only Google's own page code can produce. Your capture shows it, and the open-source `fli` client documents the switch. So the script doesn't call those endpoints. That's why there's no calendar sweep and no multi-city pricing.

## Limits

- Prices exclude seat and bag fees and change constantly. Always confirm the exact search on the airline's site before booking.
- Both scripts rely on undocumented site internals that can change without notice.
- Don't commit HAR files: they can contain cookies and personal data. `.gitignore` excludes `*.har`.

## Tests

The tests replay the responses recorded in the HAR captures (`tests/fixtures/`) through fake servers. They cover:

- requests matching the captures
- callback polling
- one-way, nearby-airport and results-page parsing
- skipping phases the site rejects
- robot checks and retries
- caching and ranking

```sh
node --test tests/*.test.mjs               # both console scripts (Node 18+)
python -m unittest discover tests          # notebook (needs pandas, ipython)
```
