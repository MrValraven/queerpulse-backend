import { UPLOAD_KIND_SPECS, UploadKind } from '../storage/upload-kinds';

/**
 * The `media` category of the Art. 20 archive: the member's OWN uploaded files.
 *
 * Two things are deliberately split apart here.
 *
 *  1. The LISTING (this module's types) is built at export time by
 *     `MediaExportContributor` and stored inline on `data_export_job.data`
 *     alongside every other category. It is metadata only — key, upload kind,
 *     byte size, last-modified — so it costs the `jsonb` payload a few hundred
 *     bytes per file and nothing more.
 *  2. The BYTES are fetched at DOWNLOAD time and streamed straight into the zip
 *     (`AccountController.downloadExport`). They never touch `job.data`.
 *
 * That split is not a style choice. `AccountExportService.build` carries an
 * explicit size warning: everything it returns is JSON-serialised into one
 * `jsonb` column. A member's avatars, listing photos and gathering covers are
 * megabytes each; base64 in a `jsonb` column would be the single fastest way to
 * make that warning come true.
 *
 * The consequence is that a `json`-format export (one `.json` file, no zip) has
 * nowhere to put binaries: it carries this listing and no bytes. The archive's
 * top-level `manifest` says so, and so does the frontend copy on the request
 * form.
 */

/**
 * Ceiling on the TOTAL bytes of media put into one zip: 256 MiB.
 *
 * Chosen rather than derived. The per-kind upload caps top out at 10 MB
 * (`UPLOAD_KIND_SPECS`), so 256 MiB is roughly 25 full-size heroes or several
 * hundred typical photos — comfortably more than any real member holds, while
 * still bounding a single synchronous request. Objects past the ceiling are
 * NOT silently dropped: they are listed under `skippedOverCap` in both the
 * archive payload and `media/manifest.json`, with their storage keys, so the
 * member can see exactly what was left behind and ask for it.
 *
 * Files are taken oldest-first up to the ceiling, so a member who is over it
 * gets a stable, explainable subset rather than an arbitrary one.
 */
export const MEDIA_EXPORT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** One of the member's stored objects, as listed in the archive. */
export interface ExportMediaFile {
  /** Path INSIDE the zip's `media/` folder, e.g. `avatars/<uuid>.jpg`. */
  name: string;
  /** The full storage key the bytes come from. */
  storageKey: string;
  /** What the object is, from the key's upload-kind prefix, or null. */
  uploadKind: UploadKind | null;
  /** Size in bytes as reported by the bucket listing. */
  sizeBytes: number;
  /** ISO timestamp of the object's last modification, or null. */
  lastModifiedAt: string | null;
}

/** The value written to the archive's `media` key by `MediaExportContributor`. */
export interface ExportMediaContribution {
  /** Total objects found in the bucket for this member. */
  objectCount: number;
  /** Bytes across every found object, cap included or not. */
  totalBytes: number;
  /** Bytes across `files` only. */
  includedBytes: number;
  /** {@link MEDIA_EXPORT_MAX_TOTAL_BYTES}, restated so the archive stands alone. */
  capBytes: number;
  /** The files a zip export carries the bytes for. */
  files: ExportMediaFile[];
  /** Objects left out because the media set hit `capBytes`. */
  skippedOverCap: ExportMediaFile[];
  /**
   * Why the bucket could not be listed at all, or null when it was.
   *
   * A storage outage must not fail the WHOLE Art. 20 export — the member's
   * profile, messages and writing are all still theirs to take. So the
   * contributor records the failure here and the archive says plainly that the
   * file list is unknown, rather than an empty list quietly implying "you
   * uploaded nothing".
   */
  listingError: string | null;
}

/** One object the download could not read, recorded in `media/manifest.json`. */
export interface ExportMediaReadFailure {
  name: string;
  storageKey: string;
  /** Why it could not be read, as reported by storage. */
  reason: string;
}

/**
 * `media/manifest.json` inside the zip: the listing above, plus what actually
 * happened while streaming.
 *
 * `status` distinguishes the three outcomes a member needs told apart, because
 * "your `media/` folder has no files in it" is ambiguous on its own:
 *
 *   `noMedia`   we hold no uploaded files for this member at all;
 *   `complete`  every file we hold is in this zip;
 *   `partial`   some files are missing — see `skippedOverCap` / `failedToRead`.
 */
export interface ExportMediaManifest extends ExportMediaContribution {
  status: 'noMedia' | 'complete' | 'partial';
  failedToRead: ExportMediaReadFailure[];
  note: string;
}

/** Prefix -> kind, inverted once from the authoritative per-kind spec table. */
const UPLOAD_KIND_BY_PREFIX = new Map<string, UploadKind>(
  (Object.keys(UPLOAD_KIND_SPECS) as UploadKind[]).map((kind) => [
    UPLOAD_KIND_SPECS[kind].prefix,
    kind,
  ]),
);

/**
 * What an object IS, read off the key's prefix (`avatars/<userId>/<uuid>.jpg`
 * -> `avatar`). Cheap by design: a prefix lookup, never a database join. An
 * unrecognised prefix returns null rather than guessing.
 */
export function uploadKindForStorageKey(key: string): UploadKind | null {
  const prefix = key.split('/')[0];
  return UPLOAD_KIND_BY_PREFIX.get(prefix ?? '') ?? null;
}

/**
 * The name an object gets inside the zip's `media/` folder: `<prefix>/<file>`,
 * i.e. the storage key with the member's own user-id segment removed. Every
 * object in the export belongs to the one member, so that segment carries no
 * information for them and only puts their internal id in a filename.
 *
 * Basenames are server-minted uuids, so collisions are not expected; the caller
 * de-duplicates defensively anyway (see `planExportMedia`).
 */
export function mediaEntryNameForKey(key: string): string {
  const segments = key.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= 1) {
    return segments[0] ?? 'file';
  }
  const prefix = segments[0];
  const basename = segments[segments.length - 1];
  return `${prefix}/${basename}`;
}

/**
 * Turn a raw bucket listing into the archive's `media` value: deterministic
 * order, key-derived names, de-duplicated, and cut off at the byte ceiling.
 *
 * Ordering is oldest-first by `lastModifiedAt` with the storage key as the
 * tie-break, so the same bucket contents always produce the same file list —
 * and therefore the same subset when the ceiling bites.
 */
export function planExportMedia(
  objects: { key: string; size: number; lastModified: string | null }[],
): ExportMediaContribution {
  const sorted = [...objects].sort((left, right) => {
    const leftModified = left.lastModified ?? '';
    const rightModified = right.lastModified ?? '';
    if (leftModified !== rightModified) {
      return leftModified < rightModified ? -1 : 1;
    }
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });

  const usedNames = new Set<string>();
  const files: ExportMediaFile[] = [];
  const skippedOverCap: ExportMediaFile[] = [];
  let totalBytes = 0;
  let includedBytes = 0;

  for (const object of sorted) {
    let name = mediaEntryNameForKey(object.key);
    if (usedNames.has(name)) {
      // Defensive only: uuid basenames do not collide in practice.
      const separatorIndex = name.lastIndexOf('.');
      const stem = separatorIndex > 0 ? name.slice(0, separatorIndex) : name;
      const extension = separatorIndex > 0 ? name.slice(separatorIndex) : '';
      let suffix = 2;
      while (usedNames.has(`${stem}-${suffix}${extension}`)) {
        suffix += 1;
      }
      name = `${stem}-${suffix}${extension}`;
    }
    usedNames.add(name);

    const file: ExportMediaFile = {
      name,
      storageKey: object.key,
      uploadKind: uploadKindForStorageKey(object.key),
      sizeBytes: object.size,
      lastModifiedAt: object.lastModified,
    };
    totalBytes += object.size;
    if (includedBytes + object.size > MEDIA_EXPORT_MAX_TOTAL_BYTES) {
      skippedOverCap.push(file);
      continue;
    }
    includedBytes += object.size;
    files.push(file);
  }

  return {
    objectCount: sorted.length,
    totalBytes,
    includedBytes,
    capBytes: MEDIA_EXPORT_MAX_TOTAL_BYTES,
    files,
    skippedOverCap,
    listingError: null,
  };
}

/** The `manifest.mediaNote` / `media/manifest.json` `note`, stated once. */
export const MEDIA_ZIP_ONLY_NOTE =
  'Your uploaded files are included as real files under media/ only when the export format is csv or both, which are delivered as a zip. A json-format export lists every file below with its storage key but carries no bytes.';

/**
 * Read a `media` value back off `data_export_job.data`.
 *
 * The payload is a `jsonb` column, so it is `unknown` on the way out and an
 * older job row may predate this category entirely. Anything that is not a
 * well-formed listing returns null and the download simply carries no media,
 * rather than throwing halfway through a response whose headers are already
 * sent.
 */
export function parseExportMedia(
  value: unknown,
): ExportMediaContribution | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Partial<ExportMediaContribution>;
  if (!Array.isArray(candidate.files)) {
    return null;
  }
  const files = candidate.files.filter(isExportMediaFile);
  const skippedOverCap = Array.isArray(candidate.skippedOverCap)
    ? candidate.skippedOverCap.filter(isExportMediaFile)
    : [];
  return {
    objectCount:
      typeof candidate.objectCount === 'number'
        ? candidate.objectCount
        : files.length + skippedOverCap.length,
    totalBytes:
      typeof candidate.totalBytes === 'number' ? candidate.totalBytes : 0,
    includedBytes:
      typeof candidate.includedBytes === 'number' ? candidate.includedBytes : 0,
    capBytes:
      typeof candidate.capBytes === 'number'
        ? candidate.capBytes
        : MEDIA_EXPORT_MAX_TOTAL_BYTES,
    files,
    skippedOverCap,
    listingError:
      typeof candidate.listingError === 'string'
        ? candidate.listingError
        : null,
  };
}

function isExportMediaFile(value: unknown): value is ExportMediaFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ExportMediaFile>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.storageKey === 'string'
  );
}

/**
 * Assemble `media/manifest.json` once the streaming pass knows what it managed
 * to read. `failedToRead` is only knowable at that point, which is why the
 * manifest is appended AFTER the files rather than described up front.
 */
export function buildExportMediaManifest(
  plan: ExportMediaContribution,
  failedToRead: ExportMediaReadFailure[],
): ExportMediaManifest {
  const hasGaps =
    plan.skippedOverCap.length > 0 ||
    failedToRead.length > 0 ||
    plan.listingError !== null;
  const status: ExportMediaManifest['status'] = hasGaps
    ? 'partial'
    : plan.objectCount === 0
      ? 'noMedia'
      : 'complete';
  return {
    ...plan,
    // The delivered file list, with anything that failed mid-download removed,
    // so the manifest describes the zip a member is actually holding.
    files: plan.files.filter(
      (file) =>
        !failedToRead.some((failure) => failure.storageKey === file.storageKey),
    ),
    status,
    failedToRead,
    note: MEDIA_ZIP_ONLY_NOTE,
  };
}
