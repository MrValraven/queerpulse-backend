/**
 * Approximate neighbourhood-centroid geocoding for housing listings.
 *
 * ADDRESS PRIVACY: pre-connection, a listing must never reveal its exact point.
 * Instead the response boundary exposes an APPROXIMATE pin at the centre of the
 * listing's `area` (neighbourhood) — or, failing that, its `city`. This table
 * is a small, dependency-free stand-in for a real forward geocoder.
 *
 * PRODUCTION SWAP-IN: replace `resolveAreaCentroid` with a call to a real
 * geocoding service (Nominatim / MapTiler / Google) keyed on `area, city`,
 * ideally resolved once at write time and cached. The precise per-listing point
 * (the gated one) would likewise come from geocoding the full address on write.
 * Everything downstream (the DTO fields, the map) already speaks lat/long, so
 * only this function changes.
 */

export interface Centroid {
  latitude: number;
  longitude: number;
}

// Accent- and case-insensitive key: "Príncipe Real" and "principe real" match.
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// Lisbon + Porto neighbourhood centroids (WGS84). Coarse by design — a
// neighbourhood centre, never a street. Extend as new areas appear in listings.
const NEIGHBOURHOOD_CENTROIDS: Record<string, Centroid> = {
  // ── Lisbon: the 24 official freguesias, mirroring the frontend's
  // shared/components/map/freguesias.data.ts label points ──
  ajuda: { latitude: 38.7131, longitude: -9.1996 },
  alcantara: { latitude: 38.71655, longitude: -9.18434 },
  alvalade: { latitude: 38.75423, longitude: -9.13886 },
  areeiro: { latitude: 38.74165, longitude: -9.12963 },
  arroios: { latitude: 38.72984, longitude: -9.13881 },
  'avenidas novas': { latitude: 38.739, longitude: -9.15042 },
  beato: { latitude: 38.72972, longitude: -9.1101 },
  belem: { latitude: 38.70199, longitude: -9.21308 },
  benfica: { latitude: 38.73444, longitude: -9.19591 },
  'campo de ourique': { latitude: 38.7187, longitude: -9.16691 },
  campolide: { latitude: 38.73077, longitude: -9.1673 },
  carnide: { latitude: 38.76409, longitude: -9.18686 },
  estrela: { latitude: 38.70597, longitude: -9.16747 },
  lumiar: { latitude: 38.76787, longitude: -9.16568 },
  marvila: { latitude: 38.74712, longitude: -9.111 },
  misericordia: { latitude: 38.71075, longitude: -9.14789 },
  olivais: { latitude: 38.77256, longitude: -9.1235 },
  'parque das nacoes': { latitude: 38.7895, longitude: -9.09414 },
  'penha de franca': { latitude: 38.72876, longitude: -9.12495 },
  'santa clara': { latitude: 38.78646, longitude: -9.15263 },
  'santa maria maior': { latitude: 38.71182, longitude: -9.13503 },
  'santo antonio': { latitude: 38.72147, longitude: -9.1471 },
  'sao domingos de benfica': { latitude: 38.74747, longitude: -9.17792 },
  'sao vicente': { latitude: 38.71832, longitude: -9.12607 },
  // ── Porto (untouched) ──
  ribeira: { latitude: 41.1405, longitude: -8.6115 },
  cedofeita: { latitude: 41.156, longitude: -8.618 },
  bonfim: { latitude: 41.152, longitude: -8.595 },
  'foz do douro': { latitude: 41.15, longitude: -8.67 },
  'baixa do porto': { latitude: 41.147, longitude: -8.61 },
};

// City-level fallback when the area is unknown or blank. Keeps a pin on the map
// (roughly the right place) rather than dropping it entirely.
const CITY_CENTROIDS: Record<string, Centroid> = {
  lisboa: { latitude: 38.7223, longitude: -9.1393 },
  lisbon: { latitude: 38.7223, longitude: -9.1393 },
  porto: { latitude: 41.1579, longitude: -8.6291 },
  oporto: { latitude: 41.1579, longitude: -8.6291 },
};

/**
 * The approximate centroid for a listing's location: the neighbourhood centre
 * if we know it, else the city centre, else null (no pin). Never returns a
 * street-level point — this is the privacy-safe coordinate.
 */
export function resolveAreaCentroid(
  city: string,
  area: string,
): Centroid | null {
  const areaKey = normalizeName(area);
  if (areaKey && NEIGHBOURHOOD_CENTROIDS[areaKey]) {
    return NEIGHBOURHOOD_CENTROIDS[areaKey];
  }
  const cityKey = normalizeName(city);
  return CITY_CENTROIDS[cityKey] ?? null;
}
