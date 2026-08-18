import { Report } from './entities/report.entity';

/**
 * A human-friendly reference code for a filed report, e.g. `"QPR-2026-0114"`
 * — shown to the reporter on their "my reports" list so they have something
 * shareable/rememberable that isn't a raw uuid. Purely a display-time
 * derivation from existing columns (`id`, `createdAt`); no new DB column.
 *
 * Deterministic (same report -> same string every call) but NOT guaranteed
 * unique across the whole `reports` table: it's the first 4 hex characters of
 * the uuid, not a sequence. The design's own example ("QPR-2026-0114") reads
 * as illustrative/non-sequential too. A collision is cosmetic only — every
 * lookup that matters uses the real `id`, this string is display-only.
 */
export function formatReportReference(
  report: Pick<Report, 'id' | 'createdAt'>,
): string {
  const year = report.createdAt.getUTCFullYear();
  const shortHex = report.id.replace(/-/g, '').slice(0, 4).toUpperCase();
  return `QPR-${year}-${shortHex}`;
}
