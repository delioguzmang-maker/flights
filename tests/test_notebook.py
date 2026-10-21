"""Runs the code cells of delta_fare_finder.ipynb against a fake Delta API built from the
response recorded in the HAR capture. Needs pandas and IPython; run with:

    python -m unittest discover tests
"""
import copy
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

# Import these before any test patches sys.modules: patch.dict drops modules imported
# inside it on exit, and numpy can't be imported twice.
import IPython.display  # noqa: F401
import pandas  # noqa: F401

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = json.loads((ROOT / 'tests/fixtures/flex_roundtrip_CHS_MXP.json').read_text())
CELLS = [c for c in json.loads((ROOT / 'delta_fare_finder.ipynb').read_text())['cells'] if c['cell_type'] == 'code']
SOURCES = [''.join(c['source']) for c in CELLS]
SETTINGS, ENGINE, SEARCH, RESULTS, DOWNLOAD, EXPORT = SOURCES

HOMES = ['CHS', 'CAE', 'GSP', 'CLT']
# Drive and parking off, for tests that check fare + hop arithmetic.
NO_DRIVE = {'drive': {'airports': {}}}
GERMANY = ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR']
# Deterministic per-airport surcharge so routes rank predictably (same as the JS test).
SURCHARGE = {'CHS': 0, 'CAE': 40, 'GSP': 60, 'CLT': -30, 'FRA': 10, 'MUC': -50, 'BER': 30, 'DUS': 20, 'HAM': 25,
             'STR': 35, 'FCO': -20, 'MXP': 0, 'VCE': 15, 'BLQ': 45, 'FLR': 50}


def scaled(delta, trip_type=None):
    data = copy.deepcopy(FIXTURE['response'])
    for offer_set in data['data']['gqlSearchOffers']['gqlOffersSets']:
        for offer in offer_set['offers']:
            price = offer['offerPricing'][0]['totalAmt']['currencyEquivalentPrice']
            price['currencyAmt'] = round(price['currencyAmt'] + delta, 2)
    if trip_type:
        data['data']['gqlSearchOffers']['offerDataList']['responseProperties']['tripTypeText'] = trip_type
    return data


def one_way_grid(base, center):
    """7 sets × 7 offers; only offers[i] in set i is the real fare (delta.com reads it that way)."""
    from datetime import date, timedelta
    mid = date.fromisoformat(center[:10])
    return {'data': {'gqlSearchOffers': {
        'offerResponseId': 'x',
        'gqlOffersSets': [{
            'itineraryDepartureDate': (mid + timedelta(days=i - 3)).isoformat(),
            'offers': [{
                'offerId': f'o{i}{j}',
                'additionalOfferProperties': {'offered': None, 'soldOut': True if i == 3 else None, 'lowestFare': False,
                                              'totalTripStopCnt': 1, 'discountAvailable': False},
                'offerPricing': [{'totalAmt': {'currencyEquivalentPrice': {'currencyAmt': base + i * 10 if j == i else 1}}}],
            } for j in range(7)],
        } for i in range(7)],
        'offerDataList': {'pricingOptions': [{'pricingOptionDetail': {'currencyCode': 'USD'}}], 'flexReturnDates': [],
                          'responseProperties': {'tripTypeText': 'ONE_WAY'}},
    }}}


class FakeResponse:
    def __init__(self, body, status=200):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class FakeDelta:
    """Stands in for the requests module."""

    class RequestException(Exception):
        pass

    def __init__(self, test, open_jaw_unsupported=False, status=200):
        self.test = test
        self.calls = []
        self.callbacks = {}
        self.open_jaw_unsupported = open_jaw_unsupported
        self.status = status
        fake = self

        class Session:
            def __init__(self):
                self.headers = {}

            def request(self, method, url, timeout=None, data=None, headers=None):
                return fake.handle(method, url, data, {**self.headers, **(headers or {})})

        self.Session = Session

    def module(self):
        mod = types.ModuleType('requests')
        mod.Session = self.Session
        mod.RequestException = self.RequestException
        return mod

    def handle(self, method, url, data, headers):
        t = self.test
        self.calls.append({'method': method, 'url': url, 'body': data, 'headers': headers})
        if self.status != 200:
            return FakeResponse({'message': 'Forbidden'}, self.status)
        if url.startswith('https://offer-api-prd.delta.com/prd/callback/'):
            t.assertEqual(method, 'GET')
            t.assertEqual(headers['Authorization'], 'GUEST')
            return FakeResponse(self.callbacks[url.rsplit('/', 1)[1]])
        t.assertEqual(url, 'https://offer-api-prd.delta.com/prd/rm-offer-gql')
        t.assertEqual(method, 'POST')
        for name, value in {'Authorization': 'GUEST', 'applicationId': 'DC', 'channelId': 'DCOM', 'Airline': 'DL',
                            'x-app-route': 'dates', 'x-app-type': 'dcom-shop', 'Origin': 'https://www.delta.com'}.items():
            t.assertEqual(headers[name], value)
        t.assertRegex(headers['TransactionId'], r'^[0-9a-f-]{36}_\d+$')
        body = json.loads(data)
        t.assertEqual(body['query'], FIXTURE['query'])
        legs = body['variables']['offerSearchCriteria']['offersCriteria']['flightRequestCriteria']['searchOriginDestination']
        a, b = legs[0]['origins'][0]['airportCode'], legs[0]['destinations'][0]['airportCode']
        if len(legs) == 1:
            europe, home = (b, a) if a in HOMES else (a, b)
            return FakeResponse(one_way_grid(520 + SURCHARGE[europe] + SURCHARGE[home], legs[0]['departureLocalTs']))
        c, d = legs[1]['origins'][0]['airportCode'], legs[1]['destinations'][0]['airportCode']
        if 'NAP' in (b, c):
            return FakeResponse({'errors': [{'message': 'no service', 'extensions': {'errors': {'code': 'ROF4002', 'moreInfo': [{'code': '404'}]}}}],
                                 'data': {'gqlSearchOffers': None}})
        if a == d and b == c:
            return FakeResponse(scaled(SURCHARGE[a] + SURCHARGE[b]))
        if self.open_jaw_unsupported:
            return FakeResponse({'errors': [{'message': 'bad trip', 'extensions': {'errors': {'code': 'ROF4002', 'moreInfo': [{'code': '210'}]}}}]})
        callback_id = f'cb-{a}-{b}-{c}-{d}'
        into_italy = 25 if b not in GERMANY else 0  # break the tie between the two directions
        self.callbacks[callback_id] = scaled(SURCHARGE[a] + SURCHARGE[b] + SURCHARGE[c] - 150 + into_italy, 'MULTI_CITY')
        return FakeResponse({'errors': [{'message': 'pending', 'extensions': {'errors': {
            'code': 'ROF5004', 'moreInfo': [{'code': 'PXY1007', 'callbackId': callback_id, 'callbackInSecs': 2}]}}}]})


class NotebookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        self.sleep = mock.patch('time.sleep')
        self.sleep.start()
        self.display = mock.patch('IPython.display.display')
        self.display.start()
        self.uploads = {}
        colab = types.ModuleType('google.colab')
        colab.files = types.SimpleNamespace(upload=lambda: self.uploads, download=lambda name: None)
        self.modules = mock.patch.dict(sys.modules, {'google': types.ModuleType('google'), 'google.colab': colab})
        self.modules.start()
        self.printed = []

    def tearDown(self):
        self.modules.stop()
        self.display.stop()
        self.sleep.stop()
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def run_cells(self, fake, *cells, config=None, ns=None):
        with mock.patch.dict(sys.modules, {'requests': fake.module()}):
            ns = ns if ns is not None else {'display': lambda *a: None, 'print': lambda *a, **k: self.printed.append(' '.join(map(str, a)))}
            exec(SETTINGS, ns)
            ns['CONFIG'].update(config or {})
            for cell in (ENGINE, *cells):
                exec(cell, ns)
            return ns

    def test_request_body_matches_har(self):
        fake = FakeDelta(self)
        self.run_cells(fake, SEARCH, config={'homeAirports': ['CHS'], 'destinations': {'Italy': ['MXP']},
                                             'visitCountries': ['Italy'], 'searchOpenJaw': False, 'searchOneWays': False})
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(json.loads(fake.calls[0]['body'])['variables'], FIXTURE['request'])

    def test_full_run(self):
        fake = FakeDelta(self)
        ns = self.run_cells(fake, SEARCH, RESULTS, DOWNLOAD, EXPORT, config=NO_DRIVE)
        rows, trips = ns['rows'], ns['trips']
        posts = [c for c in fake.calls if c['method'] == 'POST']
        self.assertEqual(len(posts), 4 * 12 + 4 * 3 * 3 * 2 + 4 * 6 * 2)
        self.assertEqual(len(fake.calls) - len(posts), 4 * 3 * 3 * 2)

        chs_mxp = [r for r in rows if r['kind'] == 'RT' and r['from'] == 'CHS' and r['to'] == 'MXP']
        self.assertEqual(len(chs_mxp), 49)
        self.assertIn({'kind': 'RT', 'from': 'CHS', 'to': 'MXP', 'from2': 'MXP', 'to2': 'CHS', 'out': '2026-12-14',
                       'ret': '2026-12-22', 'price': 831.59, 'stops': 1}, chs_mxp)
        self.assertFalse([r for r in rows if 'NAP' in (r['to'], r['from'])])

        ow = [r for r in rows if r['kind'] == 'OW-out' and r['from'] == 'CLT' and r['to'] == 'MUC']
        self.assertEqual([r['out'] for r in ow], ['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-18', '2026-12-19', '2026-12-20'])
        self.assertTrue(all(r['price'] > 100 for r in ow))

        self.assertEqual(sorted({a for r in rows if r['kind'] == 'OJ' for a in (r['to'], r['from2'])}),
                         ['DUS', 'FCO', 'FRA', 'MUC', 'MXP', 'VCE'])

        top = trips.iloc[0]
        self.assertEqual((top['strategy'], top['route'], top['hops']), ('Open-jaw', 'CLT → MUC … FCO → CLT', 1))
        self.assertAlmostEqual(top['total'], 831.59 - 30 - 50 - 20 - 150 + 75)
        rt = trips[(trips['strategy'] == 'Round trip') & (trips['to'] == 'MUC')].iloc[0]
        self.assertEqual(rt['hops'], 2)
        self.assertAlmostEqual(rt['total'], rt['airfare'] + 150)
        one_ways = trips[trips['strategy'] == 'Two one-ways']
        self.assertFalse(one_ways.empty)
        self.assertTrue((one_ways['from'] == one_ways['to2']).all())
        self.assertTrue(trips['total'].is_monotonic_increasing)

        self.assertTrue(Path('delta_trips.csv').read_text().startswith('strategy,route,from,to,from2,to2,out,ret,nights,stops,airfare,driveAndPark,hops,total'))
        self.assertTrue(any('How to book' in line for line in self.printed))
        self.assertTrue(any('Step 3 found fares, so skipping' in line for line in self.printed))

        # Second run: everything comes from the cache file.
        again = FakeDelta(self)
        ns2 = self.run_cells(again, SEARCH, RESULTS, config=NO_DRIVE)
        self.assertEqual(again.calls, [])
        self.assertEqual(ns2['trips'].iloc[0]['route'], top['route'])

    def test_open_jaw_unsupported_is_skipped(self):
        fake = FakeDelta(self, open_jaw_unsupported=True)
        ns = self.run_cells(fake, SEARCH, config={'searchOneWays': False})
        oj = [c for c in fake.calls if (lambda legs: len(legs) == 2 and legs[1]['origins'][0]['airportCode'] != legs[0]['destinations'][0]['airportCode'])(
            json.loads(c['body'])['variables']['offerSearchCriteria']['offersCriteria']['flightRequestCriteria']['searchOriginDestination'])]
        self.assertEqual(len(oj), 3)
        self.assertTrue(any('Skipping the rest' in line for line in self.printed))
        self.assertTrue(ns['rows'])

    def test_blocked_then_console_export(self):
        fake = FakeDelta(self, status=403)
        ns = self.run_cells(fake, SEARCH)
        self.assertEqual(ns['rows'], [])
        self.assertEqual(len(fake.calls), 1)
        self.assertTrue(any('Delta refused the request' in line for line in self.printed))

        # Analyse an export shaped like the console script's download, re-ranked with step-1 settings.
        export_rows = [
            {'kind': 'RT', 'from': 'CLT', 'to': 'MUC', 'from2': 'MUC', 'to2': 'CLT', 'out': '2026-12-15', 'ret': '2026-12-23', 'price': 700, 'stops': 1},
            {'kind': 'OJ', 'from': 'CHS', 'to': 'FRA', 'from2': 'FCO', 'to2': 'CHS', 'out': '2026-12-15', 'ret': '2026-12-23', 'price': 790, 'stops': 1},
            {'kind': 'OW-out', 'from': 'GSP', 'to': 'MXP', 'from2': None, 'to2': None, 'out': '2026-12-16', 'ret': None, 'price': 400, 'stops': None},
            {'kind': 'OW-back', 'from': 'MUC', 'to': 'GSP', 'from2': None, 'to2': None, 'out': '2026-12-24', 'ret': None, 'price': 380, 'stops': 0},
        ]
        export_config = dict(ns['CONFIG'], hopCost=1)  # the step-1 hopCost should win
        self.uploads = {'delta-fares.json': json.dumps({'config': export_config, 'currency': 'USD', 'rows': export_rows}).encode()}
        self.run_cells(fake, EXPORT, config={'hopCost': 100, **NO_DRIVE}, ns=ns)
        trips = ns['trips']
        self.assertEqual(list(trips['strategy']), ['Two one-ways', 'Open-jaw', 'Round trip'])
        self.assertEqual(list(trips['total']), [880, 890, 900])
        self.assertEqual(trips.iloc[0]['stops'], '?+0')

    def test_console_v2_export(self):
        """Exports from the console script carry extra airports, extra home airports and the
        countries of airports its nearby-airports search found."""
        fake = FakeDelta(self, status=403)
        ns = self.run_cells(fake, SEARCH)
        export_config = dict(ns['CONFIG'], moreAirports={'Netherlands': ['AMS']}, extraHomeAirports={'ATL': 100})
        rows = [
            {'kind': 'RT', 'from': 'CLT', 'to': 'AMS', 'from2': 'AMS', 'to2': 'CLT', 'out': '2026-12-15', 'ret': '2026-12-23', 'price': 600, 'stops': 1},
            {'kind': 'RT', 'from': 'ATL', 'to': 'FCO', 'from2': 'FCO', 'to2': 'ATL', 'out': '2026-12-15', 'ret': '2026-12-23', 'price': 650, 'stops': 0},
            {'kind': 'RT', 'from': 'GSO', 'to': 'SZG', 'from2': 'SZG', 'to2': 'GSO', 'out': '2026-12-15', 'ret': '2026-12-23', 'price': 705, 'stops': None},
            # Another week (the console's "other weeks" search): outside your dates, so not ranked here.
            {'kind': 'RT', 'from': 'CLT', 'to': 'FCO', 'from2': 'FCO', 'to2': 'CLT', 'out': '2026-11-24', 'ret': '2026-12-02', 'price': 400, 'stops': 1},
        ]
        self.uploads = {'delta-fares.json': json.dumps({'config': export_config, 'currency': 'USD', 'rows': rows, 'countryOf': {'SZG': 'Germany'}}).encode()}
        self.run_cells(fake, EXPORT, config={'hopCost': 100}, ns=ns)
        trips = ns['trips']
        # With the default Columbia drive table, 8 nights: CLT 95 mi + 9 days × $14 = $146,
        # ATL 215 mi + 9 × $14 = $172; GSO has no drive figures, so nothing is added.
        self.assertEqual([(t['to'], t['hops'], t['driveAndPark'], t['total']) for _, t in trips.iterrows()],
                         [('SZG', 2, 0, 905), ('FCO', 2, 172, 1022), ('AMS', 3, 146, 1046)])
        self.assertTrue(any('No drive/parking figures for GSO' in line for line in self.printed))

    def test_blocked_run_all_does_not_stall(self):
        """When Delta refuses Colab, step 4 explains why and the download cell doesn't crash."""
        fake = FakeDelta(self, status=403)
        self.uploads = {}
        ns = self.run_cells(fake, SEARCH, RESULTS, DOWNLOAD)
        self.assertEqual(ns['rows'], [])
        self.assertTrue(any('No fares to rank: step 3 found nothing' in line for line in self.printed))
        self.assertTrue(any('Nothing to download yet' in line for line in self.printed))

    def test_too_many_searches_refused(self):
        fake = FakeDelta(self)
        ns = self.run_cells(fake, SEARCH, config={'departDates': ['2026-12-01', '2026-12-31'], 'returnDates': ['2027-01-01', '2027-01-31'], 'maxNights': 60})
        self.assertEqual(fake.calls, [])
        self.assertEqual(ns['rows'], [])


if __name__ == '__main__':
    unittest.main()
