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
  // ── Lisbon ──
  'principe real': { latitude: 38.7176, longitude: -9.1503 },
  arroios: { latitude: 38.73, longitude: -9.135 },
  graca: { latitude: 38.7223, longitude: -9.13 },
  marvila: { latitude: 38.738, longitude: -9.101 },
  'cais do sodre': { latitude: 38.7057, longitude: -9.1454 },
  mouraria: { latitude: 38.7167, longitude: -9.1355 },
  alfama: { latitude: 38.7118, longitude: -9.129 },
  chiado: { latitude: 38.7106, longitude: -9.141 },
  'bairro alto': { latitude: 38.713, longitude: -9.147 },
  alcantara: { latitude: 38.705, longitude: -9.178 },
  belem: { latitude: 38.6975, longitude: -9.2036 },
  estrela: { latitude: 38.7135, longitude: -9.1607 },
  'campo de ourique': { latitude: 38.718, longitude: -9.166 },
  intendente: { latitude: 38.722, longitude: -9.136 },
  anjos: { latitude: 38.726, longitude: -9.135 },
  santos: { latitude: 38.708, longitude: -9.156 },
  lapa: { latitude: 38.7085, longitude: -9.165 },
  penha: { latitude: 38.735, longitude: -9.128 },
  benfica: { latitude: 38.75, longitude: -9.2 },
  // ── Porto ──
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
