/**
 * Flight-identifier classification and exact matching for the location search.
 *
 * Pure: no DOM and no Cesium. Identity equality is the comparison `find_aircraft`
 * uses (trim, then case-insensitive). Search also ignores spaces and dashes in
 * the query and in the stored identity before that comparison.
 *
 * The repository has no airline IATA→ICAO table. A caller may pass one so
 * DL123 can match a live DAL123; the built-in map is empty on purpose.
 */

/** How long a search waits for the first Live Flights snapshot after enabling the layer. */
export const FLIGHT_SEARCH_LOAD_TIMEOUT_MS = 8000;

/**
 * No built-in airline-designator table. Pass a map to {@link callsignCandidates}
 * or {@link matchFlightIdentifier} when one is available.
 * @type {Readonly<Record<string, string>>}
 */
export const IATA_TO_ICAO = Object.freeze({});

const ICAO_CALLSIGN = /^[A-Z]{3}\d{1,4}[A-Z]?$/;
/** Two-character IATA airline code (letter or digit, at least one letter) plus a flight number. */
const IATA_CALLSIGN = /^(?=.*[A-Z])[A-Z0-9]{2}\d{1,4}[A-Z]?$/;
/**
 * US N-number: N, a leading digit 1-9, at most five digits total, and up to
 * two registration letters (I and O are not used). Five digits leave no room
 * for a letter; two letters leave room for at most three digits.
 */
const N_NUMBER =
  /^N(?:[1-9]\d{0,4}|[1-9]\d{0,3}[A-HJ-NP-Z]|[1-9]\d{0,2}[A-HJ-NP-Z]{2})$/;
const ICAO24 = /^[0-9A-F]{6}$/;

/**
 * Uppercase an identity and drop spaces and dashes.
 * @param {*} value
 * @returns {string}
 */
export function normalizeFlightQuery(value) {
  return String(value ?? '')
    .replace(/[\s-]+/g, '')
    .toUpperCase();
}

/**
 * Exact aircraft-identity comparison shared with `find_aircraft`.
 * Null and blank fields compare as empty. Spaces inside a value are kept;
 * callers that ignore them normalize both sides first.
 * @param {*} recordValue Field stored on the aircraft.
 * @param {*} wanted Value the caller asked for.
 * @returns {boolean}
 */
export function aircraftIdentityEquals(recordValue, wanted) {
  return (
    String(recordValue || '')
      .trim()
      .toUpperCase() ===
    String(wanted || '')
      .trim()
      .toUpperCase()
  );
}

/**
 * Callsign forms to try. A 2-character IATA code expands when `iataToIcao`
 * names its ICAO airline code; a 3-letter ICAO callsign is already canonical.
 * @param {string} display Normalized callsign.
 * @param {Record<string, string>} [iataToIcao]
 * @returns {string[]}
 */
export function callsignCandidates(display, iataToIcao = IATA_TO_ICAO) {
  const normalized = normalizeFlightQuery(display);
  if (!normalized) return [];
  const candidates = [normalized];
  const iata = /^([A-Z0-9]{2})(\d{1,4})([A-Z]?)$/.exec(normalized);
  if (!iata) return candidates;
  const mapped = iataToIcao?.[iata[1]] ?? iataToIcao?.[iata[1].toLowerCase()];
  const airline = normalizeFlightQuery(mapped);
  if (!airline) return candidates;
  const expanded = `${airline}${iata[2]}${iata[3]}`;
  if (expanded !== normalized) candidates.push(expanded);
  return candidates;
}

/**
 * @param {string} display
 * @returns {string|null} Lowercase ICAO24 when `display` is six hex characters and contains a digit.
 */
function hexAddress(display) {
  return ICAO24.test(display) && /\d/.test(display)
    ? display.toLowerCase()
    : null;
}

/**
 * Classify a search-box query.
 *
 * Strong misses skip geocoding: a 3-letter ICAO callsign (`DAL123`, `UAL9`)
 * or an N-number with at least three characters after the N (`N123`,
 * `N12345`, `N123AB`). Weak misses fall through to place search: a
 * 2-character IATA-style form (`DL123`, `M25`, `I95`, `US101`), a short
 * N-number (`N1`, `N12`), or a 6-character hex address that contains a digit.
 * Words of only hex letters (`facade`, `beaded`) are not addresses. Anything
 * else, including coordinates and place names, is not a flight query.
 *
 * @param {*} query
 * @param {{ iataToIcao?: Record<string, string> }} [options]
 * @returns {{
 *   kind: 'callsign'|'registration'|'hex',
 *   display: string,
 *   strong: boolean,
 *   callsigns: string[],
 *   registration: string|null,
 *   icao24: string|null,
 * }|null}
 */
export function classifyFlightQuery(query, { iataToIcao = IATA_TO_ICAO } = {}) {
  const display = normalizeFlightQuery(query);
  if (!display || !/^[A-Z0-9]+$/.test(display)) return null;
  const icao24 = hexAddress(display);
  if (N_NUMBER.test(display)) {
    return {
      kind: 'registration',
      display,
      // N1 and N12 are also route numbers. A tail needs 3+ characters.
      strong: display.slice(1).length >= 3,
      callsigns: [],
      registration: display,
      icao24,
    };
  }
  if (ICAO_CALLSIGN.test(display)) {
    return {
      kind: 'callsign',
      display,
      strong: true,
      callsigns: callsignCandidates(display, iataToIcao),
      registration: null,
      icao24,
    };
  }
  if (IATA_CALLSIGN.test(display)) {
    return {
      kind: 'callsign',
      display,
      strong: false,
      callsigns: callsignCandidates(display, iataToIcao),
      registration: null,
      icao24,
    };
  }
  if (icao24) {
    return {
      kind: 'hex',
      display,
      strong: false,
      callsigns: [],
      registration: null,
      icao24,
    };
  }
  return null;
}

/**
 * How a classified query may use Live Flights.
 * Strong queries load the layer, enabling it when it is off.
 * Weak queries only read identities when the layer is already on.
 * @param {object|null|undefined} classified
 * @param {{ enabled?: boolean }} [options]
 * @returns {'load'|'match'|'skip'}
 */
export function flightSearchLoadPlan(classified, { enabled = false } = {}) {
  if (!classified) return 'skip';
  if (classified.strong) return 'load';
  return enabled ? 'match' : 'skip';
}

/** Toast copy for a strong flight query that matched nothing live. */
export function liveFlightMissText(queryOrClassified) {
  const display =
    typeof queryOrClassified === 'string'
      ? normalizeFlightQuery(queryOrClassified)
      : queryOrClassified?.display;
  return `No live flight matching ${display}`;
}

function recordId(record) {
  return String(record?.id ?? record?.icao24 ?? '').trim();
}

/**
 * Exact-match one classified query against already-loaded flight identities.
 * Airline callsign beats registration beats an N-number carried as the
 * callsign (OpenSky leaves registration empty until enrichment) beats hex.
 * Equal tier breaks on ascending id.
 * @param {Array<{id?: string, icao24?: string, callsign?: string|null, registration?: string|null}>} records
 * @param {string|object} query Raw query or a {@link classifyFlightQuery} result.
 * @param {{ iataToIcao?: Record<string, string> }} [options]
 * @returns {{id: string, callsign: string|null, registration: string|null}|null}
 */
export function matchFlightIdentifier(
  records,
  query,
  { iataToIcao = IATA_TO_ICAO } = {},
) {
  const classified =
    query && typeof query === 'object'
      ? query
      : classifyFlightQuery(query, { iataToIcao });
  if (!classified) return null;
  const callsigns = classified.callsigns?.length
    ? classified.callsigns
    : classified.kind === 'callsign'
      ? callsignCandidates(classified.display, iataToIcao)
      : [];
  let best = null;
  for (const record of records || []) {
    const id = recordId(record);
    if (!id) continue;
    const callsign = normalizeFlightQuery(record?.callsign);
    const registration = normalizeFlightQuery(record?.registration);
    const callsignHit = callsigns.some((candidate) =>
      aircraftIdentityEquals(callsign, candidate),
    );
    const registrationHit =
      classified.registration &&
      aircraftIdentityEquals(registration, classified.registration);
    // General-aviation tails are broadcast as the callsign. Registration is
    // filled later, so the tail still selects that aircraft.
    const tailAsCallsign =
      classified.registration &&
      aircraftIdentityEquals(callsign, classified.registration);
    const hexHit =
      classified.icao24 && aircraftIdentityEquals(id, classified.icao24);
    const tier = callsignHit
      ? 0
      : registrationHit
        ? 1
        : tailAsCallsign
          ? 2
          : hexHit
            ? 3
            : null;
    if (tier === null) continue;
    if (
      !best ||
      tier < best.tier ||
      (tier === best.tier && id.toLowerCase() < best.id.toLowerCase())
    ) {
      best = {
        tier,
        id,
        callsign: record.callsign ?? null,
        registration: record.registration ?? null,
      };
    }
  }
  if (!best) return null;
  return {
    id: best.id,
    callsign: best.callsign,
    registration: best.registration,
  };
}

function abortedFlightSearch() {
  const error = new Error('Flight search aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Enable Live Flights when it is off, then wait until that enable settles.
 * The timeout ends the wait only. It does not cancel the enable, so the
 * layer toggle still completes. An aborted search rejects.
 * @param {object} options
 * @param {() => boolean} [options.isEnabled]
 * @param {(args: {signal: AbortSignal|undefined}) => Promise<unknown>} [options.enable]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<'ready'|'timeout'|'failed'|'unavailable'>}
 */
export async function ensureFlightsLoaded({
  isEnabled,
  enable,
  signal,
  timeoutMs = FLIGHT_SEARCH_LOAD_TIMEOUT_MS,
} = {}) {
  if (signal?.aborted) throw abortedFlightSearch();
  if (typeof isEnabled === 'function' && isEnabled()) return 'ready';
  if (typeof enable !== 'function') return 'unavailable';

  let timer;
  let onAbort;
  let finishAbort = () => {};
  let timedOut = false;
  const pending = Promise.resolve()
    .then(() => enable({ signal }))
    .then(() => 'ready')
    .catch((error) => {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      return 'failed';
    });
  // Reject as soon as the search is cancelled. Waiting out the load, or the
  // timeout, would keep a superseded query alive after the next keystroke.
  const aborted = new Promise((resolve, reject) => {
    finishAbort = resolve;
    if (!signal) return;
    onAbort = () => reject(abortedFlightSearch());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([
      pending,
      aborted,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve('timeout');
        }, timeoutMs);
      }),
    ]);
    if (signal?.aborted) throw abortedFlightSearch();
    return outcome;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    finishAbort();
    aborted.catch(() => {});
    if (timedOut || signal?.aborted) pending.catch(() => {});
  }
}
