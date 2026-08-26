import {
  DataExportFormat,
  DataExportJob,
} from './entities/data-export-job.entity';
import { toCsv } from './export-csv';
import { ExportMediaContribution, parseExportMedia } from './export-media';

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
 *
 * The first six are the original core contributions
 * (`AccountExportService.coreContributions`); the rest are the newer-domain
 * contributors registered in `data-export-contributors.ts` /
 * `NEW_DOMAIN_EXPORT_CONTRIBUTORS`. Both lists build the archive the same way —
 * a category missing from here would still land in the `json`/`both` payload
 * (built from `job.data`) but silently vanish from a `csv`-only export, so
 * every registered contributor's `archiveKey` must appear here too.
 *
 * ONE registered contributor is deliberately absent: `media`. Its archive value
 * is not a table of rows but a listing of the member's uploaded FILES, and the
 * zip delivers those as actual files under `media/` plus a `media/manifest.json`
 * describing them (see `export-media.ts`). Flattening that listing into a
 * `media.csv` would restate the manifest in a worse format, so it stays out for
 * the same reason `manifest` does — and unlike a genuinely forgotten key,
 * nothing is lost from a csv-only export by its absence.
 */
export const EXPORT_CSV_CATEGORIES = [
  'profile',
  'messages',
  'posts',
  'events',
  'connections',
  'activity',
  'subprofiles',
  'listings',
  'housing',
  'saved',
  'notifications',
  'consent',
  // Pre-existing gap, closed here: `membershipCards` has been a registered
  // contributor since spec §K.3 but never appeared in this list, so it landed
  // in the `json`/`both` payload and silently vanished from a `csv`-only
  // export — the exact failure the paragraph above warns about. Latent rather
  // than live, since the request form offers no `membershipCards` checkbox yet.
  'membershipCards',
  'magazine',
  'communities',
  'volunteering',
  'governance',
  'reviews',
] as const;

/**
 * One file to put in the zip.
 *
 * A discriminated union because the two sources are genuinely different: a
 * `text` entry's bytes are already in memory (a CSV or a JSON blob rendered
 * from `job.data`), while a `stored` entry's bytes live in the member's bucket
 * and are fetched and STREAMED at download time. Describing the stored entries
 * here — rather than fetching them — is what keeps this module pure and
 * synchronous: it says which objects belong in the archive, and
 * `AccountController` does the I/O.
 */
export type ExportEntry =
  | { kind: 'text'; name: string; content: string }
  | { kind: 'stored'; name: string; storageKey: string };

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
      /**
       * The `media` listing the archive was built with, or null when the member
       * did not request that category (or the job predates it).
       *
       * Its `files` are the SAME objects the `stored` entries above name — the
       * entries are the append plan, this is the manifest source. The
       * controller needs it separately because `media/manifest.json` can only
       * be written once streaming is done and it knows which objects failed to
       * read, and a failure is recorded rather than fatal.
       */
      media: ExportMediaContribution | null;
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
      kind: 'text',
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
    entries.push({
      kind: 'text',
      name: `${key}.csv`,
      content: toCsv(data[key]),
    });
  }
  if (job.format === DataExportFormat.Both) {
    entries.push({ kind: 'text', name: `${base}.json`, content: json });
  }

  // The member's own uploaded files, named but NOT read here. They come last in
  // the zip so the text entries are already on the wire before the first bucket
  // round trip, and so a slow or partly unreadable bucket cannot delay the part
  // of the archive that is guaranteed to be there.
  const media = parseExportMedia(data.media);
  if (media) {
    for (const file of media.files) {
      entries.push({
        kind: 'stored',
        name: `media/${file.name}`,
        storageKey: file.storageKey,
      });
    }
  }

  return {
    kind: 'zip',
    filename: `${base}.zip`,
    contentType: 'application/zip',
    entries,
    media,
    modifiedAt: job.generatedAt ?? job.requestedAt,
  };
}
