/**
 * The registry contract for the Art. 20 personal-data export (`POST
 * /account/export`, assembled by `AccountExportService`).
 *
 * Each domain that holds personal data contributes ONE top-level section of the
 * archive by implementing this interface and registering under the
 * `DATA_EXPORT_CONTRIBUTORS` token. The export service iterates every registered
 * contributor rather than hard-coding a fixed list of categories, so a NEW
 * domain cannot be silently forgotten from the export: wiring a contributor is
 * the single, discoverable step that adds it.
 *
 * `archiveKey` is the frontend-facing contract (`useExportFlow.ts`'s
 * `buildDemoArchive`), which may differ from the request `category` id — e.g.
 * `forumPosts` -> `posts`, `activityLog` -> `activity`. A contribution is only
 * built (and its key only added) when the caller requested its `category`;
 * a category the caller did not ask for is omitted entirely, matching the demo
 * archive's `undefined`-drops-on-`JSON.stringify` behavior.
 */
export interface DataExportContribution {
  /** The request category id that switches this contribution on. */
  readonly category: string;
  /** The top-level archive key this contribution writes to. */
  readonly archiveKey: string;
  /** Build this member's data for the archive. Called only when requested. */
  buildContribution(userId: string): Promise<unknown>;
}

/**
 * DI token collecting every registered {@link DataExportContribution}. Provided
 * as an array via a factory in `AccountModule`; injected by
 * `AccountExportService`.
 */
export const DATA_EXPORT_CONTRIBUTORS = Symbol('DATA_EXPORT_CONTRIBUTORS');
