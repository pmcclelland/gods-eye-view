// Flight identifiers in the location search box: what counts as a callsign,
// N-number, or hex address, and which loaded aircraft that query selects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IATA_TO_ICAO,
  aircraftIdentityEquals,
  callsignCandidates,
  classifyFlightQuery,
  ensureFlightsLoaded,
  flightSearchLoadPlan,
  liveFlightMissText,
  matchFlightIdentifier,
  normalizeFlightQuery,
} from './flightQuery.js';

const FLIGHTS = [
  { id: 'a1b2c3', callsign: 'DAL123', registration: 'N12345' },
  { id: 'abc123', callsign: 'UAL9', registration: 'N99AB' },
  { id: 'ffffff', callsign: 'SWA100', registration: null },
  { id: '0d1122', callsign: 'DAL 123', registration: 'N-123AB' },
  { id: 'bbbbbb', callsign: 'DL999', registration: null },
];

test('the identifier classifier accepts callsigns, N-numbers and digit-bearing hex only', () => {
  assert.equal(classifyFlightQuery('DAL123')?.kind, 'callsign');
  assert.equal(classifyFlightQuery('dal123')?.display, 'DAL123');
  assert.equal(classifyFlightQuery('DAL-123')?.display, 'DAL123');
  assert.equal(classifyFlightQuery('DAL 123')?.display, 'DAL123');
  assert.equal(classifyFlightQuery('DL123')?.kind, 'callsign');
  assert.equal(classifyFlightQuery('dl 123')?.display, 'DL123');
  assert.equal(classifyFlightQuery('UAL9')?.display, 'UAL9');
  assert.equal(classifyFlightQuery('DAL123A')?.display, 'DAL123A');
  assert.equal(classifyFlightQuery('B6123')?.kind, 'callsign');
  assert.equal(classifyFlightQuery('DAL123')?.strong, true);
  assert.equal(classifyFlightQuery('UAL9')?.strong, true);
  assert.equal(classifyFlightQuery('DL123')?.strong, false);
  assert.equal(classifyFlightQuery('B6123')?.strong, false);

  const tail = classifyFlightQuery('N12345');
  assert.equal(tail?.kind, 'registration');
  assert.equal(tail?.strong, true);
  assert.equal(classifyFlightQuery('n-123ab')?.display, 'N123AB');
  assert.equal(classifyFlightQuery('N 123 AB')?.display, 'N123AB');

  const hex = classifyFlightQuery('a1b2c3');
  assert.equal(hex?.kind, 'hex');
  assert.equal(hex?.strong, false);
  assert.equal(hex?.icao24, 'a1b2c3');
  assert.equal(classifyFlightQuery('A1B2C3')?.icao24, 'a1b2c3');

  for (const query of [
    'Paris',
    'New York',
    '40.7,-74.0',
    'facade',
    'beaded',
    'abcdef',
    'DAL',
    'N',
    '',
    '   ',
  ]) {
    assert.equal(classifyFlightQuery(query), null, query);
  }
});

test('a callsign that is also hex stays a strong callsign and still notes the address', () => {
  const both = classifyFlightQuery('abc123');
  assert.equal(both?.kind, 'callsign');
  assert.equal(both?.strong, true);
  assert.equal(both?.icao24, 'abc123');
  assert.deepEqual(both?.callsigns, ['ABC123']);
});

test('road and route names are weak and do not enable Live Flights', async () => {
  for (const query of [
    'M25',
    'I-95',
    'US101',
    'SR520',
    'B52',
    'DL123',
    'N1',
    'N12',
  ]) {
    const classified = classifyFlightQuery(query);
    assert.ok(classified, query);
    assert.equal(classified.strong, false, query);
    assert.equal(
      flightSearchLoadPlan(classified, { enabled: false }),
      'skip',
      query,
    );
    // A miss is not a toast. The search falls through to place geocoding.
    assert.equal(matchFlightIdentifier(FLIGHTS, query), null, query);
  }
  assert.equal(classifyFlightQuery('I-95')?.display, 'I95');
  assert.equal(classifyFlightQuery('N1')?.kind, 'registration');
  assert.equal(classifyFlightQuery('N12')?.strong, false);
  assert.equal(classifyFlightQuery('DAL123')?.strong, true);
  assert.equal(classifyFlightQuery('N123')?.strong, true);
  assert.equal(classifyFlightQuery('N12345')?.strong, true);
  assert.equal(classifyFlightQuery('N123AB')?.strong, true);
  assert.equal(
    flightSearchLoadPlan(classifyFlightQuery('DAL123'), { enabled: false }),
    'load',
  );
  assert.equal(
    flightSearchLoadPlan(classifyFlightQuery('N12345'), { enabled: false }),
    'load',
  );
  // Already enabled: read the loaded aircraft, still without toggling.
  assert.equal(
    flightSearchLoadPlan(classifyFlightQuery('M25'), { enabled: true }),
    'match',
  );

  const calls = [];
  const plan = flightSearchLoadPlan(classifyFlightQuery('US101'), {
    enabled: false,
  });
  if (plan === 'load') {
    await ensureFlightsLoaded({
      isEnabled: () => false,
      enable: () => {
        calls.push('enable');
        return Promise.resolve(true);
      },
    });
  }
  assert.deepEqual(calls, []);
});

test('an N-number is a registration and not a hex address', () => {
  // N is not a hex digit, so no N-number is an ICAO24 address.
  const tail = classifyFlightQuery('N12345');
  assert.equal(tail?.kind, 'registration');
  assert.equal(tail?.icao24, null);
  assert.equal(tail?.strong, true);
});

test('IATA callsigns expand only through a supplied ICAO map', () => {
  assert.equal(IATA_TO_ICAO.DL, undefined);
  assert.deepEqual(callsignCandidates('DL123'), ['DL123']);
  assert.deepEqual(callsignCandidates('dl-123', { DL: 'DAL' }), [
    'DL123',
    'DAL123',
  ]);
  assert.deepEqual(callsignCandidates('DL123A', { DL: 'dal' }), [
    'DL123A',
    'DAL123A',
  ]);
  // A 3-letter ICAO callsign is already the live form.
  assert.deepEqual(callsignCandidates('UAL9', { UA: 'UAL' }), ['UAL9']);
  assert.deepEqual(normalizeFlightQuery('dal 123'), 'DAL123');
});

test('matching uses exact identity equality against a loaded flight list', () => {
  assert.equal(aircraftIdentityEquals(' dal123 ', 'DAL123'), true);
  assert.equal(aircraftIdentityEquals('DAL123', 'DAL12'), false);

  assert.equal(matchFlightIdentifier(FLIGHTS, 'DAL123')?.id, '0d1122');
  assert.equal(matchFlightIdentifier(FLIGHTS, 'dal-123')?.id, '0d1122');
  assert.equal(matchFlightIdentifier(FLIGHTS, 'UAL9')?.id, 'abc123');
  assert.equal(matchFlightIdentifier(FLIGHTS, 'N12345')?.id, 'a1b2c3');
  assert.equal(matchFlightIdentifier(FLIGHTS, 'n-123ab')?.id, '0d1122');
  assert.equal(matchFlightIdentifier(FLIGHTS, 'a1b2c3')?.id, 'a1b2c3');
  // Letter-only hex is a place query even when a loaded id looks the same.
  assert.equal(matchFlightIdentifier(FLIGHTS, 'FFFFFF'), null);

  // Prefix and substring hits are not flights. DAL12 must not grab DAL123.
  assert.equal(matchFlightIdentifier(FLIGHTS, 'DAL12'), null);
  assert.equal(matchFlightIdentifier(FLIGHTS, 'SWA'), null);
  assert.equal(classifyFlightQuery('Paris'), null);
  assert.equal(matchFlightIdentifier(FLIGHTS, 'Paris'), null);
  assert.equal(matchFlightIdentifier(FLIGHTS, '40.7,-74.0'), null);
  assert.equal(matchFlightIdentifier(FLIGHTS, 'New York'), null);
  assert.equal(matchFlightIdentifier(FLIGHTS, 'DAL999'), null);

  // No built-in table: DL123 matches a live DL123, not DAL123.
  assert.equal(matchFlightIdentifier(FLIGHTS, 'DL123'), null);
  assert.equal(matchFlightIdentifier(FLIGHTS, 'DL999')?.id, 'bbbbbb');
  assert.equal(
    matchFlightIdentifier(FLIGHTS, 'DL123', { iataToIcao: { DL: 'DAL' } })?.id,
    '0d1122',
  );
});

test('callsign beats registration beats hex, and ties break on id', () => {
  const rows = [
    { id: 'ffffff', callsign: 'ZZZ1', registration: 'N12345' },
    { id: 'aaaaaa', callsign: 'N12345', registration: null },
  ];
  // The tail number on the registration beats the same text used as a callsign.
  assert.equal(matchFlightIdentifier(rows, 'N12345')?.id, 'ffffff');
  const addressed = [
    { id: 'abc123', callsign: 'OTHER', registration: null },
    { id: 'bbbbbb', callsign: 'ABC123', registration: null },
  ];
  assert.equal(matchFlightIdentifier(addressed, 'abc123')?.id, 'bbbbbb');
  // Before adsbdb fills registration, the tail is only the broadcast callsign.
  assert.equal(
    matchFlightIdentifier(
      [
        { id: 'n12345', callsign: 'OTHER', registration: null },
        { id: 'abc111', callsign: 'N 12345', registration: null },
      ],
      'N12345',
    )?.id,
    'abc111',
  );

  const twins = [
    { id: 'bbbbbb', callsign: 'UAL9', registration: null },
    { id: 'aaaaaa', callsign: 'UAL9', registration: null },
  ];
  assert.equal(matchFlightIdentifier(twins, 'UAL9')?.id, 'aaaaaa');
});

test('a strong miss names the normalized query', () => {
  assert.equal(liveFlightMissText('dal 123'), 'No live flight matching DAL123');
  assert.equal(
    liveFlightMissText(classifyFlightQuery('n-123ab')),
    'No live flight matching N123AB',
  );
});

test('enabling Live Flights waits for the first load and times out without cancelling it', async () => {
  let enabled = false;
  const calls = [];
  const ready = await ensureFlightsLoaded({
    isEnabled: () => enabled,
    enable: () => {
      calls.push('enable');
      enabled = true;
      return Promise.resolve(true);
    },
  });
  assert.equal(ready, 'ready');
  assert.deepEqual(calls, ['enable']);

  const again = await ensureFlightsLoaded({
    isEnabled: () => true,
    enable: () => {
      calls.push('again');
      return Promise.resolve(true);
    },
  });
  assert.equal(again, 'ready');
  assert.deepEqual(calls, ['enable']);

  let settled = false;
  const outcome = await ensureFlightsLoaded({
    isEnabled: () => false,
    enable: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          settled = true;
          resolve(true);
        }, 50);
      }),
    timeoutMs: 15,
  });
  assert.equal(outcome, 'timeout');
  assert.equal(settled, false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, true);
});

test('an aborted flight load rejects and does not report a miss', async () => {
  const controller = new AbortController();
  const pending = ensureFlightsLoaded({
    isEnabled: () => false,
    enable: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
