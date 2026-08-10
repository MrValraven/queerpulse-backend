import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * How a member knows a safe space they vouch for. Mirrors the frontend vouch
 * modal's relationship options. Stored as a plain varchar (not a PG enum) so a
 * new option can be added without a schema migration — the same
 * extensible-status precedent used for safe-space nomination status and
 * staff-role codes.
 */
export type SafeSpaceVouchRelationship =
  'regular' | 'once_or_twice' | 'work_or_volunteer' | 'with_friend';

export const SAFE_SPACE_VOUCH_RELATIONSHIPS: SafeSpaceVouchRelationship[] = [
  'regular',
  'once_or_twice',
  'work_or_volunteer',
  'with_friend',
];

/**
 * The display byline for a member vouch, derived from the relationship. Powers
 * the `byline` on the read-path `SafeSpaceVouch` shape (which the curated jsonb
 * vouches carry as free text) — a stable, presentation-only label so a
 * relationship code never leaks to the client. Falls back to a neutral label
 * for a null/unknown relationship.
 */
export function safeSpaceVouchByline(
  relationship: SafeSpaceVouchRelationship | null,
): string {
  switch (relationship) {
    case 'regular':
      return 'Regular here';
    case 'once_or_twice':
      return 'Visits now and then';
    case 'work_or_volunteer':
      return 'Works or volunteers here';
    case 'with_friend':
      return 'Came with a friend';
    default:
      return 'QueerPulse member';
  }
}

/**
 * One member's public vouch for a verified safe space. This is the NORMALIZED,
 * member-written counterpart to the moderator-curated `listings.safe_space_vouches`
 * jsonb column: a member self-vouches once per space through
 * `POST /safe-spaces/:slug/vouch`, and the read path merges these rows with the
 * curated jsonb ones so the detail page shows both.
 *
 * The table is deliberately named `safe_space_member_vouches` (NOT
 * `safe_space_vouches`) to avoid any confusion with the identically-purposed
 * jsonb column already named `safe_space_vouches` on the `listings` table.
 *
 * Mirrors the member-vouch entity (`Vouch`): one row per (space, voucher) ever,
 * a UNIQUE constraint enforces "vouch once", and a withdrawal soft-deletes via
 * `withdrawnAt` (null = active) rather than removing the row.
 */
@Entity('safe_space_member_vouches')
@Unique('UQ_safe_space_member_vouches_listing_voucher', [
  'listingId',
  'voucherId',
])
export class SafeSpaceMemberVouch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_safe_space_member_vouches_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  @Index('IDX_safe_space_member_vouches_voucher_id')
  @Column({ type: 'uuid' })
  voucherId!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  relationship!: SafeSpaceVouchRelationship | null;

  @Column({ type: 'boolean', default: false })
  anonymous!: boolean;

  // Soft-delete: a withdrawn vouch keeps its row but is excluded from every
  // count/list. Null = active. Mirrors `Vouch.withdrawnAt`.
  @Column({ type: 'timestamptz', nullable: true })
  withdrawnAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
