import { SubprofileItemRevision } from '../entities/subprofile-item-revision.entity';

// Protect Your Work (revision history), Task 8: hand-written response shapes
// for the list/get revision endpoints. No global serializer in this backend
// (see CLAUDE.md), so every entity -> DTO mapping is written by hand here.

export interface ItemRevisionSummary {
  id: string;
  createdAt: string;
  title: string | null;
}

export interface ItemRevisionDetail {
  id: string;
  createdAt: string;
  snapshot: Record<string, unknown>;
}

export function toRevisionSummary(
  revision: SubprofileItemRevision,
): ItemRevisionSummary {
  return {
    id: revision.id,
    createdAt: revision.createdAt.toISOString(),
    title: (revision.snapshot?.['title'] as string | undefined) ?? null,
  };
}

export function toRevisionDetail(
  revision: SubprofileItemRevision,
): ItemRevisionDetail {
  return {
    id: revision.id,
    createdAt: revision.createdAt.toISOString(),
    snapshot: revision.snapshot,
  };
}
