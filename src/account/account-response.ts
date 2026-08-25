import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { DAY_MS, EXPORT_LINK_EXPIRY_DAYS } from './account.constants';
import {
  DataExportJob,
  DataExportStatus,
} from './entities/data-export-job.entity';
import { DeletionRequest } from './entities/deletion-request.entity';
import { DsarRequest } from './entities/dsar-request.entity';

// Matches the frontend's `DeletionRequest` in
// `features/settings/api/account.api.ts`.
export interface DeletionRequestResponse {
  id: string;
  status: 'grace' | 'processing' | 'erased';
  requestedAt: string;
  scheduledErasureAt: string;
  gracePeriodDays: number;
}

export function toDeletionRequestResponse(
  r: DeletionRequest,
  gracePeriodDays: number,
): DeletionRequestResponse {
  return {
    id: r.id,
    // `Cancelled` is never surfaced on the wire — only the currently-active
    // `Grace`/`Processing` row is ever passed to this mapper (see the
    // service's `findOne` filters).
    status: r.status as 'grace' | 'processing' | 'erased',
    requestedAt: r.createdAt.toISOString(),
    scheduledErasureAt: r.scheduledFor.toISOString(),
    gracePeriodDays,
  };
}

// Matches the frontend's `ExportJob` in
// `features/settings/api/account.api.ts`. Returned by BOTH
// `POST /account/export` and `GET /account/export/:jobId` — the frontend
// polls the latter with the same envelope shape it got from the former.
export interface ExportJobResponse {
  jobId: string;
  status: DataExportJob['status'];
  requestedAt: string;
  downloadUrl?: string;
  sizeBytes?: number;
  expiresAt?: string;
  error?: string;
}

export function toExportJobResponse(job: DataExportJob): ExportJobResponse {
  const ready = job.status === DataExportStatus.Ready;
  const expiresAt =
    ready && job.generatedAt
      ? new Date(
          job.generatedAt.getTime() + EXPORT_LINK_EXPIRY_DAYS * DAY_MS,
        ).toISOString()
      : undefined;
  return {
    jobId: job.id,
    status: job.status,
    requestedAt: job.requestedAt.toISOString(),
    downloadUrl: ready ? `/account/export/${job.id}/download` : undefined,
    // The size of the STORED payload, which is always JSON — not of the file
    // the download route will actually serve. For `format: 'csv'`/`'both'` that
    // route streams a zip whose size is only known once it has been deflated,
    // so reporting it here would mean compressing the whole archive on every
    // status poll. This over-reports (text zips ~10x) rather than under-
    // reports, which is the safe direction for a "this is how big your
    // download is" hint.
    sizeBytes:
      ready && job.data
        ? Buffer.byteLength(JSON.stringify(job.data))
        : undefined,
    expiresAt,
    error: job.error ?? undefined,
  };
}

// Mirrors the frontend's `DsarRequest` type in
// `features/settings/api/account.api.ts`.
export interface DsarResponse {
  reference: string;
  article: number;
  status: string;
  submittedAt: string;
  dueBy: string;
  respondedAt?: string;
}

export function toDsarResponse(r: DsarRequest): DsarResponse {
  return {
    reference: r.reference,
    article: r.article,
    status: r.status,
    submittedAt: r.submittedAt.toISOString(),
    dueBy: r.dueBy.toISOString(),
    respondedAt: r.respondedAt ? r.respondedAt.toISOString() : undefined,
  };
}

// Matches the shape consumed by `SessionsPage.tsx`. The refresh-token store
// has no `deviceLabel` column, so `deviceLabel` is always `null`. `current`
// is supplied by the caller (see `AccountService.listSessions`), which
// resolves the presenting session's family from the `refresh_token` cookie.
export interface SessionResponse {
  /**
   * The refresh-token FAMILY id, which is the stable identity of the session.
   * Deliberately not the row id: rows rotate roughly every 15 minutes, so a row
   * id would go stale in the page's hands (see `AccountService.revokeSession`).
   */
  id: string;
  deviceLabel: string | null;
  userAgent: string;
  current: boolean;
  /** When this device SIGNED IN, unchanged by the rotations since. */
  createdAt: string;
  /**
   * The last time this device rotated a token, so the closest thing the store
   * holds to "last seen". Coarse by nature: an idle tab refreshes on its own
   * schedule, so this trails real activity by up to one access-token lifetime.
   */
  lastUsedAt: string;
  expiresAt: string;
}

export function toSessionResponse(
  t: RefreshToken,
  current: boolean,
): SessionResponse {
  return {
    id: t.familyId,
    deviceLabel: null,
    userAgent: t.userAgent ?? '',
    current,
    createdAt: t.sessionStartedAt.toISOString(),
    lastUsedAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt.toISOString(),
  };
}

// Matches the frontend's `ReauthResult` in `features/settings/api/account.api.ts`.
export interface ReauthResult {
  reauthToken: string;
  expiresAt: string;
}

// Matches the frontend's `EmailPreference` in
// `features/settings/api/account.api.ts`.
export interface EmailPreferenceResponse {
  category: string;
  email: boolean;
  locked?: boolean;
  /**
   * ⚠️ ALWAYS `true` for now. `MailerService` is wired and does deliver, but
   * no sender consults these categories: nothing reads `email_preference`
   * before sending, and no digest/reminder/product-update job exists. Every
   * toggle here is stored and never acted on. This flag exists so the
   * endpoint's own payload states the gap rather than implying delivery; the FE
   * renders it as "this isn't live yet". Drop it (or flip to omitted) once a
   * sender honours the stored preference.
   */
  comingSoon: boolean;
}
