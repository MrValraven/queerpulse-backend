import {
  DataExportFormat,
  DataExportJob,
} from './entities/data-export-job.entity';
import { toCsv } from './export-csv';

/**
 * Turns a ready `data_export_job` into a description of the file to serve for
 * `GET /account/export/:jobId/download`.
 *
 * Pure and synchronous on purpose. Everything here is derived from the payload
 * that is ALREADY in memory (`job.data`, the inline `jsonb` column) — nothing
 * is persisted, nothing is written to disk, and no second copy of the archive
 * is built. In particular the zip is NOT produced here: this returns the
 * entries, and the controller streams them through `archiver` straight into the
 * response, so the compressed archive never exists as a whole in memory.
 *
 * That is also why the size warning on `AccountExportService.build` is not made
 * worse by CSV support: the ceiling is still one payload in heap, exactly as
 * before, and CSV rendering is per-category rather than per-archive.
 */

/**
 * The archive's top-level category keys, in the order they appear in the zip.
 *
 * This mirrors `AccountExportService.build` — and deliberately uses the ARCHIVE
 * key, not the category id the request used, so `forumPosts` is `posts.csv` and
 * `activityLog` is `activity.csv`. `manifest` is excluded: it is metadata about
 * the export, not a category of member data, and it stays JSON.
 */
export const EXPORT_CSV_CATEGORIES = [
  'profile',
  'messages',
  'posts',
  'events',
  'connections',
  'activity',
] as const;

export interface ExportEntry {
  name: string;
  content: string;
}

export type ExportDownload =
  | {
      kind: 'json';
      filename: string;
      contentType: 'application/json';
      body: Buffer;
    }
  | {
      kind: 'zip';
      filename: string;
      contentType: 'application/zip';
      entries: ExportEntry[];
      // Stamped on every zip entry so two downloads of the same job produce
      // byte-identical archives. Left to `archiver`'s default it would be
      // `new Date()` per entry, which makes the file differ on every request
      // for no reason.
      modifiedAt: Date;
    };

export function describeExportDownload(job: DataExportJob): ExportDownload {
  const data: Record<string, unknown> = job.data ?? {};
  const json = JSON.stringify(data, null, 2);
  // Keeps the job id in the filename, as this route has always done: a member
  // exporting twice ends up with two files in one Downloads folder, and
  // `queerpulse-export.json (1)` is not a useful disambiguation.
  const base = `queerpulse-export-${job.id}`;

  // Anything that is not explicitly csv/both serves the single `.json` file,
  // byte-for-byte as before. Defaulting the unknown case to the pre-existing
  // behaviour means a bad/legacy enum value degrades to a working download
  // rather than an empty zip.
  if (
    job.format !== DataExportFormat.Csv &&
    job.format !== DataExportFormat.Both
  ) {
    return {
      kind: 'json',
      filename: `${base}.json`,
      contentType: 'application/json',
      body: Buffer.from(json, 'utf8'),
    };
  }

  const entries: ExportEntry[] = [];
  // The manifest carries `schemaVersion`, `exportedAt` and the requested
  // category list. Flattened into a CSV it would be a one-row file whose only
  // interesting column is a joined array, so it stays JSON in both zip formats
  // — without it, a csv-only archive has no record of what was asked for.
  if (data.manifest !== undefined) {
    entries.push({
      name: 'manifest.json',
      content: JSON.stringify(data.manifest, null, 2),
    });
  }
  for (const key of EXPORT_CSV_CATEGORIES) {
    // A category the member did not request has no key at all — no file. See
    // `toCsv` for why "absent" and "empty" are distinguishable this way.
    if (!(key in data)) {
      continue;
    }
    entries.push({ name: `${key}.csv`, content: toCsv(data[key]) });
  }
  if (job.format === DataExportFormat.Both) {
    entries.push({ name: `${base}.json`, content: json });
  }

  return {
    kind: 'zip',
    filename: `${base}.zip`,
    contentType: 'application/zip',
    entries,
    modifiedAt: job.generatedAt ?? job.requestedAt,
  };
}
