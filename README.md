# Fare finders for delta.com and Google Flights

Two DevTools console scripts, one per site, plus a Colab notebook. They search every combination of home airports (**CAE, CLT, GSP, CHS**, plus farther ones like Atlanta and Augusta) and European airports, and rank the ways of doing a two-country trip (e.g. Germany + Italy):

| Strategy | Example | Getting between countries |
|---|---|---|
| **Round trip** | CLT ⇄ MXP | 2 hops (Italy → Germany → back to Italy) |
| **Open-jaw** (multi-city) | CLT → MUC … FCO → CLT | 1 hop (Germany → Italy) |
| **Two one-ways** | CLT → MUC, FCO → CLT as separate tickets | 1 hop |
| **Via a US hub** (Google script) | CAE → JFK on one ticket, JFK → MXP on another | depends where you land |

Each option is ranked by its **estimated total = airfare + drive & parking + hops × `hopCost`**:

- **Drive & parking:** gas for the drive to the airport and back from Columbia, SC, plus parking for every day you're away (see the table below).
- **`hopCost`:** what one train or budget-airline ticket between the countries costs you. Munich ↔ Milan/Venice by FlixBus/train or Ryanair/easyJet is often $30–100. That way "round trip + 2 hops" is compared fairly with "open-jaw + 1 hop".

| | [`delta_fare_finder.js`](delta_fare_finder.js) | [`google_flights_finder.js`](google_flights_finder.js) |
|---|---|---|
| Run it on | a delta.com tab | a google.com/travel/flights tab (google.com, not a country site) |
| Airlines | Delta and partners (Air France, KLM, Virgin, ITA…) | Every airline Google Flights shows (American, United, Air Canada, JetBlue, Lufthansa, TAP, budget carriers…) |
| One search covers | one home airport → one European airport, 7 × 7 departure/return dates | several home airports → up to 7 European airports, one date pair |
| Multi-city prices | yes | no (Google only prices these inside its own page code); it prints ready-made multi-city links to check by hand |
| Default plan | ~250 searches, ~15 min | ~135 searches, ~15 min |

Both work in Chrome, Edge and Firefox. Run both: Delta's grid is the fastest way to sweep dates, and Google catches cheaper airlines Delta doesn't sell.

## Drive and parking from Columbia, SC

Both scripts and the notebook add this to every trip. The figures live in `CONFIG.drive`, so edit them if you live elsewhere or park off-airport.

- **Gas:** two drives at $3.00/gal and 28 mpg.
- **Parking:** each day you're away (nights + 1), at the airport's cheapest on-airport long-term lot (rates from the airport websites, Oct 2026).

| Airport | Miles (one way) | Parking per day | 9-night trip |
|---|---|---|---|
| CAE Columbia | 10 | $12 surface lot | $122 |
| GSP Greenville-Spartanburg | 95 | $10 economy | $120 |
| CLT Charlotte | 95 | $14 Long Term | $160 |
| CHS Charleston | 115 | $13 economy | $155 |
| AGS Augusta | 75 | $10 long-term | $116 |
| SAV Savannah | 160 | $7 Value Park | $104 |
| MYR Myrtle Beach | 150 | $12 long-term | $152 |
| AVL Asheville | 160 | $12 shuttle lot | $154 |
| RDU Raleigh-Durham | 225 | $10 Economy 3 | $148 |
| ATL Atlanta | 215 | $14 economy | $186 |

Parking matters more than gas. So CAE isn't free, Savannah's $7 lot makes it cheaper to use than CAE, and every extra night costs $7–14. If someone can drop you off and pick you up, set `drive.dropOff: true`: you then pay gas for two round trips and no parking. For anything else an airport costs you, such as a hotel the night before an early flight, use `homeAirportExtraCost`, e.g. `{ ATL: 120 }`.

## What your runs showed so far

**Delta** (12,936 trip options in your `trips-2026-10-09` CSV, airfare only):

- **Cheapest:** round trip **CLT ⇄ MXP, Dec 14 → Dec 22, $788**. The best open-jaw was CLT → NAP … BER → CLT at $869, about one hop more, so the two come out even.
- **Italy is much cheaper to fly into than Germany:** $788 against $1,015.
- **Prices climb steeply towards Christmas.** The typical (median) route's cheapest fare was $1,042 departing Dec 14, $1,301 on Dec 17 and $1,777 on Dec 18. Every best fare departed Dec 14, the first day searched, so **earlier weeks are likely cheaper still**. Returning by Dec 25 ($788–803) was cheaper than after Christmas ($905).
- **On airfare alone, the four home airports were within $10 of each other** ($788–798). With drive and parking added, CAE or GSP usually comes out ahead of CLT and CHS.

**Google Flights** (first ~30 searches of your run):

- **Lisbon was the cheapest gateway:** $707–768 on American or United from CLT/CAE/GSP.
- **Italy came next:** CLT → Milan on Air Canada for $732.
- **Germany was $975+.**

That's why the new version searches Portugal, Spain, the UK, Iceland and Central Europe too, prices each home airport on its own, and tries separate tickets through a US hub.

## delta.com script

1. Open <https://www.delta.com>. Any page works, logged in or not.
2. Press **F12** (Mac: **Cmd+Option+J**) and open the **Console** tab.
3. Edit the `CONFIG` block at the top of [`delta_fare_finder.js`](delta_fare_finder.js) if you want. Copy the whole file, paste it into the console and press Enter. The browser may first ask you to type `allow pasting`.
4. Leave the tab open while it runs. Progress prints line by line.

It searches in this order:

| Phase | Searches | What it's for |
|---|---|---|
| Round trips | 48 | every home airport ⇄ the 12 main airports in Germany and Italy |
| More airports | 34 | your 2 cheapest home airports (fare + drive) ⇄ smaller German/Italian airports (NUE, CGN, LEJ, HAJ, PSA, LIN, TRN, BRI, CTA) and cheap hubs elsewhere (AMS, CDG, MAD, BCN, ZRH, VIE, DUB, LIS). A third country counts as one more hop. |
| Nearby airports | 4 | Delta's own "nearby airports" search (100 miles around both ends) on your best routes. European airports it turns up are ranked. Airports near home are listed with their price but not ranked, since there's no drive cost for them; add them to `drive.airports` and `extraHomeAirports` to include them. Experimental: it skips itself if Delta rejects it. |
| Open-jaw | 72 | into one country, home from the other, via the 3 cheapest airports in each |
| One-ways | 24 | separate tickets from your 2 cheapest home airports |
| More home airports | 36 | ATL, AGS, SAV, MYR, AVL, RDU ⇄ the best European airports, each with its own drive and parking cost |
| Other weeks | 30 | the 5 cheapest routes with the searched week moved 1–3 weeks earlier or later (no gaps or overlaps with what was searched) |

When it finishes you get:

- **Cheapest by strategy** and the **top 25 routes** on your dates, each showing airfare, drive & parking, hops and est. total.
- **Best trip from each home airport**, drive and parking included.
- **Cheaper if you can move the trip:** shifted weeks that beat your best option on your dates, and by how much.
- **Cheapest round trip to each European airport**, including the extra and nearby airports.
- The home airport × destination matrix (airfare), and **how to book** the best options on delta.com.
- Two downloads: `delta-trips-….csv` (every combination, with `driveAndPark` and `yourDates` columns) and `delta-fares-….json` (raw fares, which the notebook can analyse). If the browser asks to allow multiple downloads, allow it. If the JSON still doesn't arrive, type `copy(JSON.stringify(deltaFares.export))` in the console and paste it into a file. Everything is also in `window.deltaFares`.

Stop early with `window.DELTA_FARE_STOP = true`; what was found so far still gets ranked. The script also stops by itself after 5 failed searches in a row, in case Delta starts blocking.

Searches are cached in the browser for 6 hours, so a re-run skips what's already fetched. Failed searches aren't cached, so a re-run retries them.

To skip a phase, set `moreAirports: {}`, `searchNearbyAirports: false`, `extraHomeAirports: []` or `otherWeeks: false`. To change settings without editing the file, set e.g. `window.DELTA_FARE_CONFIG = { hopCost: 60 }` before pasting.

## Google Flights script

1. Open <https://www.google.com/travel/flights>. It has to be google.com: on a country site like google.co.uk the browser blocks the script's requests.
2. Open the Console as above, paste [`google_flights_finder.js`](google_flights_finder.js) and press Enter.

It searches in this order:

| Phase | Searches | What it's for |
|---|---|---|
| Round trips | 60 | CAE/CLT/GSP/CHS together ⇄ Germany, Italy and "Other hubs" (LIS, MAD, BCN, AMS, CDG, DUB, ZRH), for every departure (Dec 12–16) × return (Dec 21–24) |
| More places | 15 | 5 more groups on the 3 cheapest date pairs: more German airports, more Italian airports (LIN, BGY, TRN, VRN…), Portugal/Spain/France (OPO, FAO, AGP, ORY, NCE…), UK/Ireland/Iceland (LHR, LGW, MAN, KEF…) and Central Europe (VIE, PRG, BUD, WAW…). A group named after a country you're visiting ("More Italy") counts as that country. |
| Each home airport | 20 | CAE, CLT, GSP, CHS, AGS, SAV, ATL, MYR, AVL and RDU one at a time, on the two cheapest groups. Google's results page only lists its top few flights, so this is the fair comparison between airports. |
| Via US hubs | ~6 | two separate tickets: a transatlantic round trip from JFK, EWR, BOS, IAD, PHL, MCO or MIA, plus a domestic round trip from home to that hub. The script only pairs flights that leave at least 3 hours (`hubConnectionHours`) to connect on the way out; check the way back yourself. If the first flight is late, the second airline doesn't have to rebook you. |
| One-ways | 27 | separate one-way tickets each way, where budget transatlantic airlines show up |
| Other weeks | 8 | the two cheapest trips moved 1 and 2 weeks earlier and later |

You get the same kinds of tables as the Delta script:
- cheapest by strategy and the top routes, with airline, stops and flight numbers
- the best trip from each home airport
- the cheapest trip into each destination group
- the US-hub combinations, with their connection times
- a departure × return price grid
- trips that are cheaper if you move them
- Google's own "cheaper dates" suggestions
- multi-city links worth opening by hand, sorted by how cheap one-ways to those airports were

Every result has a **Google Flights link** that opens that exact search so you can book it.

Downloads `google-trips-….csv` and `google-fares-….json`; everything is also in `window.googleFares`. Stop with `window.GF_FARE_STOP = true`.

Google is stricter about automated traffic than Delta. Keep `delayMs` at 3–6 seconds. If you see "Google wants to check you're not a robot", run a normal search in the tab, solve the check if shown, wait a few minutes and paste again. Finished searches are cached. The script also stops by itself if three searches in a row come back without flight data, instead of carrying on blindly.

## Colab notebook

[`delta_fare_finder.ipynb`](delta_fare_finder.ipynb) runs the basic Delta search (round trips, open-jaw, one-ways) from Python, with the same drive and parking costs. **Delta may refuse requests from cloud machines.** If it does, run the console script and upload its `delta-fares-….json` in step 5. The notebook then re-ranks the fares on your dates as pandas DataFrames, using your step-1 `hopCost` and `drive` settings. It understands the extra and nearby airports in the console script's exports. Fares the console found for other weeks are only in the console output and its CSV.

Open it in Colab with **File → Upload notebook**, or **File → Open notebook → GitHub** (tick *Include private repos* if this repo is private).

## How it works

**delta.com** (from your first HAR capture)

- The flexible-dates grid is one GraphQL call: `POST https://offer-api-prd.delta.com/prd/rm-offer-gql` (`gqlSearchOffers`). Each leg carries `calenderDateRequest: {daysBeforeCnt: 3, daysAfterCnt: 3}`, and each call returns 7 × 7 outbound × return dates.
- The script sends what the site sends for a guest. The headers are `Authorization: GUEST`, which the HAR export strips, plus `applicationId: DC`, `channelId: DCOM`, `Airline: DL`, `x-app-type: dcom-shop`, `x-app-route: dates` and `TransactionId`, with cookies. The request body matches the capture byte for byte.
- Sometimes the API replies with error `ROF5004_PXY1007` and a `callbackId`. The script then polls `GET /prd/callback/{callbackId}`, as the site does.
- Grids are read the way delta.com's code reads them. In a round-trip grid, each offer set is an outbound date and its offers line up with `flexReturnDates`. In a one-way grid, the fare for set *i* is `offers[i]`.
- Your run confirmed that 2-leg multi-city grids work.
- The nearby-airports search is the site's "flexible airports" call: the same endpoint, `x-app-route: airport`, and `airportRadiusMileCnt: 100 MI` on both ends of every leg. Its request and response layout come from the site's code, not a capture, so it is marked experimental.
- delta.com also has a monthly price calendar (`calendarSearch: true`). It isn't used: how its return dates work is only inferred, and the week-shifted grids answer "is another week cheaper?" with a request format already proven by your run.

**Google Flights** (from your second HAR capture, a CHS/GSP/CLT/CAE → Madrid search)

- A search is addressed by the `tfs=` URL parameter, a small protobuf holding trip type, passengers, cabin and per-leg date and airports. The script's encoder reproduces your captured URL byte for byte.
- The results page embeds its flights in `AF_initDataCallback({key: 'ds:1', …})`. The script fetches that page for each search and reads the itinerary rows the page shows: price, airlines, flight numbers, times, stops and layovers. It also reads Google's "cheaper dates" hint (your capture's hint: Dec 15–25 for $869 vs $1,304).
- Since August 2026, Google's internal endpoints (`GetShoppingResults`, `GetCalendarGraph`, …) require an `x-goog-batchexecute-bgr` anti-bot signature that only Google's own page code can produce. Your capture shows it, and the open-source `fli` client documents the switch. So the script doesn't call those endpoints. That's why there's no calendar sweep and no multi-city pricing.

## Limits

- Prices exclude seat and bag fees and change constantly. Always confirm the exact search on the airline's site before booking.
- Parking rates and miles are estimates. Check the airport's site, and edit `CONFIG.drive` if you park elsewhere.
- Separate tickets (one-ways from different airlines, US-hub combinations) aren't protected if one flight is late or cancelled. Leave long connections.
- Both scripts rely on undocumented site internals that can change without notice.
- Don't commit HAR files: they can contain cookies and personal data. `.gitignore` excludes `*.har`.

## Tests

The tests replay the responses recorded in the HAR captures (`tests/fixtures/`) through fake servers. They cover:
- requests matching the captures
- callback polling
- one-way, nearby-airport and results-page parsing
- drive and parking costs
- skipping phases the site rejects
- failure circuit-breakers, robot checks and retries
- caching and ranking

```sh
node --test tests/*.test.mjs               # both console scripts (Node 18+)
python -m unittest discover tests          # notebook (needs pandas, ipython)
```
