import {
  CommunityGivingKind,
  CommunityGivingMethod,
} from './entities/community-giving-method.entity';

/**
 * One way to support a community, as `GET` and `PUT
 * /communities/:slug/giving` serve it. `id` is regenerated on every
 * effective save, so the client uses it as a render key only. `value` is the
 * canonical form `community-giving-rules.ts` stores; the client formats it for
 * display and copies it as is.
 */
export interface CommunityGivingMethodDTO {
  id: string;
  kind: CommunityGivingKind;
  label: string | null;
  value: string;
  note: string | null;
  position: number;
}

/**
 * A community's giving section ("Support" in the UI). `methods` is sorted by
 * `position` ascending. `updatedAt` is the time of the last effective save,
 * or null when no method is listed.
 */
export interface CommunityGivingDTO {
  intro: string | null;
  methods: CommunityGivingMethodDTO[];
  updatedAt: string | null;
}

/**
 * Maps the community's intro and its giving rows, in the order given (the
 * service sorts by position). Every effective save rewrites the whole set,
 * so the latest row `updatedAt` is the section's "last changed".
 */
export function toCommunityGivingDTO(
  intro: string | null,
  rows: CommunityGivingMethod[],
): CommunityGivingDTO {
  let latestUpdatedAt: Date | null = null;
  for (const row of rows) {
    if (latestUpdatedAt === null || row.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = row.updatedAt;
    }
  }
  return {
    intro,
    methods: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      value: row.value,
      note: row.note,
      position: row.position,
    })),
    updatedAt: latestUpdatedAt === null ? null : latestUpdatedAt.toISOString(),
  };
}
