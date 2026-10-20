import type { ModAuditService } from '../moderation/mod-audit.service';
import {
  CREATOR_DRAFT_KINDS,
  CREATOR_DRAFT_VIEWED_ACTION,
  CreatorDraftKind,
} from './creator-drafts.constants';

export type CreatorDraftAuditSurface =
  'creator_drafts' | 'listing_drafts' | 'studio_staff';

export function creatorDraftViewedNote(
  kind: CreatorDraftKind,
  draftId: string,
  surface: CreatorDraftAuditSurface,
): string {
  return JSON.stringify({ v: 1, kind, draftId, surface });
}

export function parseCreatorDraftViewedNote(
  note: string | null,
): { kind: CreatorDraftKind } | null {
  if (!note) return null;
  try {
    const parsed: unknown = JSON.parse(note);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const kind = (parsed as { kind?: unknown }).kind;
    return CREATOR_DRAFT_KINDS.find((candidate) => candidate === kind)
      ? { kind: kind as CreatorDraftKind }
      : null;
  } catch {
    return null;
  }
}

/** One audit row per staff detail read. `targetUserId` stays null: a named
 * author would tell moderators who keeps an unfinished draft. */
export async function recordCreatorDraftViewed(
  modAudit: Pick<ModAuditService, 'writeAuditLog'>,
  actorId: string,
  kind: CreatorDraftKind,
  draftId: string,
  surface: CreatorDraftAuditSurface,
): Promise<void> {
  await modAudit.writeAuditLog(
    null,
    actorId,
    CREATOR_DRAFT_VIEWED_ACTION,
    undefined,
    creatorDraftViewedNote(kind, draftId, surface),
  );
}
