# Delta fare finder

delta.com's flexible-dates price grid only searches one departure airport and one arrival airport at a time. These tools run that same search for every combination of nearby home airports and European airports. They then rank three ways of doing a two-country trip (e.g. Germany + Italy):

| Strategy | Example | Getting between countries |
|---|---|---|
| **Round trip** | CLT ⇄ MUC | 2 hops (Germany → Italy → back to Germany) |
| **Open-jaw** (multi-city) | CLT → MUC … FCO → CLT | 1 hop (Germany → Italy) |
| **Two one-ways** | CLT → MUC, FCO → CLT as separate tickets | 1 hop |

Each option is ranked by **estimated total = airfare + hops × `hopCost` + any home-airport cost you set**. Use `hopCost` for what one train or budget-airline ticket between the countries costs you (Munich ↔ Milan/Venice by FlixBus/train or Ryanair/easyJet is often $30–100). That way "round trip + 2 hops" is compared fairly with "open-jaw + 1 hop".

Defaults are taken from the search in your HAR capture: home airports **CHS, CAE, GSP, CLT**, depart **Dec 14–20 2026**, return **Dec 22–28 2026**, 1 adult. Destinations are FRA, MUC, BER, DUS, HAM and STR in Germany, and FCO, MXP, VCE, NAP, BLQ and FLR in Italy.

## Option 1: browser console script (most reliable)

1. Open <https://www.delta.com> in Chrome or Edge. Any page works, logged in or not.
2. Press **F12** (Mac: **Cmd+Option+J**) and open the **Console** tab.
3. Open [`delta_fare_finder.js`](delta_fare_finder.js) and edit the `CONFIG` block at the top if you want different dates, airports or `hopCost`. Copy the whole file, paste it into the console and press Enter. Chrome may first ask you to type `allow pasting`.
4. Leave the tab open. A full run is ~170 searches, about 8–10 minutes. Progress prints line by line.

When it finishes you get:

- **Cheapest by strategy**: whether round trip, open-jaw or two one-ways wins.
- **Top 25 routes**: the best dates for each.
- **Home airport × destination matrix**: the cheapest round-trip airfare for each pair.
- **How to book the top 5** on delta.com: which search type, airports and dates to enter.
- Two downloads: `delta-trips-….csv` (every combination) and `delta-fares-….json` (raw fares, which the notebook can analyse).
- `window.deltaFares` in the console, for poking around.

Stop early with `window.DELTA_FARE_STOP = true`; what was found so far still gets ranked. Searches are cached in the browser for 6 hours. Re-running with a different `hopCost`, nights range or home-airport cost doesn't hit Delta again. To change settings without editing the file, set `window.DELTA_FARE_CONFIG = { hopCost: 60, maxNights: 10 }` before pasting.

## Option 2: Google Colab notebook

Open [`delta_fare_finder.ipynb`](delta_fare_finder.ipynb) in Colab with **File → Upload notebook**, or **File → Open notebook → GitHub** (tick *Include private repos* if this repo is private). Edit step 1 and choose **Runtime → Run all**.

The notebook runs the same search from Google's servers. **Delta may refuse requests from cloud machines.** If step 3 prints `Delta refused the request`, run the console script instead, then upload the `delta-fares-….json` it downloads in step 5. You get the same tables, plus pandas DataFrames to filter and sort.

## Settings worth changing

| Setting | What it does |
|---|---|
| `homeAirports` | Add `'SAV'` or `'ATL'` if you'd drive there. Each airport adds about 12 round-trip searches plus its share of open-jaw and one-way searches. |
| `homeAirportExtraCost` | Gas and parking for each airport, e.g. `{ CLT: 80 }` if CLT is a long drive. |
| `destinations` | European airports to price, grouped by country. |
| `visitCountries`, `hopCost` | Countries you must see, and your per-person cost of one hop between them. |
| `departDates`, `returnDates` | Inclusive ranges. Each 7-day block × 7-day block is one search per route. |
| `minNights`, `maxNights` | Trip-length filter. |
| `adults` | Prices come back for the whole party. |
| `gatewaysPerCountry` | Open-jaw and one-way searches use the N cheapest airports per country found in the round-trip scan (default 3). |
| `mixHomeAirports` | Allow one-way pairs like leaving from CLT and coming home to CHS. |
| `searchOpenJaw`, `searchOneWays` | Turn those phases off to save time. |
| `delayMs` | Pause between searches. Keep it polite or Delta may block your IP for a while. |

## How it works (what the HAR showed)

- The flexible-dates grid comes from one GraphQL call: `POST https://offer-api-prd.delta.com/prd/rm-offer-gql`. The query is `gqlSearchOffers`, and each leg carries `calenderDateRequest: {daysBeforeCnt: 3, daysAfterCnt: 3}`. Each call returns a 7 × 7 grid of outbound × return dates.
- delta.com sends `Authorization: GUEST` for logged-out users (Chrome's HAR export strips that header). It also sends the `applicationId: DC`, `channelId: DCOM`, `Airline: DL`, `x-app-type: dcom-shop`, `x-app-route: dates` and `TransactionId` headers, with cookies. The scripts send the same; the request body matches the capture byte for byte (see the tests).
- Sometimes the API replies with error `ROF5004_PXY1007` and a `callbackId`. The scripts then poll `GET /prd/callback/{callbackId}`, as the site does.
- Grid layout follows delta.com's own code. In a round-trip grid, each offer set is an outbound date and its offers line up with `flexReturnDates`. In a one-way grid, the fare for set *i* is `offers[i]`.
- The default `brand: 'MAIN'` matches the site. That grid already includes Basic Economy fares, so it shows the lowest price.
- **Open-jaw (multi-city) grids are unverified.** The site only builds them internally, and the HAR has no example. The scripts try them. If the first 3 come back as errors, they skip the phase and say so. In that case, check the top round-trip gateways by hand with delta.com's Multi-City search.

## Limits

- delta.com only sells Delta and its partners (Air France, KLM, Virgin Atlantic and others). CLT is an American Airlines hub, so also compare against Google Flights. It lets you enter several origins (`CHS, CAE, GSP, CLT`) and a whole country as the destination.
- Prices exclude seat and bag fees and change constantly. Always confirm the exact search on delta.com before booking.
- This relies on an undocumented API that can change without notice.
- Don't commit HAR files: they can contain cookies and personal data. `.gitignore` excludes `*.har`.

## Tests

The tests replay the response recorded in the HAR (`tests/fixtures/`) through a fake API. They check the request body against the capture, the callback flow, one-way parsing, skipping unsupported open-jaw grids, caching and the ranking.

```sh
node --test tests/*.test.mjs               # console script (Node 18+)
python -m unittest discover tests          # notebook (needs pandas, ipython)
```
