import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { HandleOwnerKind } from './handle.entity';

/**
 * The `handle_history` reservation ledger — one row per handle that has been
 * RELEASED (a username rename or a subprofile unpublish). It exists to close an
 * impersonation hole: mentions are stored as raw `@slug` text and re-resolved to
 * a user at fan-out time, so a handle reclaimed by a stranger the instant it is
 * freed would silently re-point every old `@slug` at the new owner.
 *
 * Each row records WHO last held the name and, crucially, `reclaimableAt`
 * (= `releasedAt` + the cooldown window). Until that moment the name is treated
 * as TAKEN for everyone EXCEPT its previous owner, who may reclaim it. After the
 * window anyone may claim it, and claiming clears the row. See `HandlesService`.
 *
 * `name` is the PK, so an upsert keeps only the LATEST release per name; the row
 * mirrors the `handles` owner shape (exactly one of `previous_owner_user_id` /
 * `previous_owner_subprofile_id` set, matching `previous_owner_kind`), enforced
 * by the same CHECK-constraint style in the migration. It reuses the existing
 * `handles_owner_kind_enum` type rather than minting a new one.
 */
@Entity('handle_history')
export class HandleHistory {
  // The normalized released handle, PRIMARY KEY — one reservation per name.
  @PrimaryColumn({ type: 'varchar' })
  name!: string;

  @Column({
    type: 'enum',
    enum: HandleOwnerKind,
    enumName: 'handles_owner_kind_enum',
  })
  previousOwnerKind!: HandleOwnerKind;

  // Set when previousOwnerKind === 'profile'; null otherwise (enforced by the
  // migration CHECK constraint). Cascades so a deleted user drops the
  // reservation — a name whose previous owner no longer exists is nobody's to
  // protect, so it becomes freely claimable again.
  @Index('IDX_handle_history_previous_owner_user_id')
  @Column({ type: 'uuid', nullable: true })
  previousOwnerUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'previous_owner_user_id' })
  previousOwnerUser!: User | null;

  // Set when previousOwnerKind === 'subprofile'; null otherwise. Cascades so a
  // deleted subprofile drops the reservation.
  @Index('IDX_handle_history_previous_owner_subprofile_id')
  @Column({ type: 'uuid', nullable: true })
  previousOwnerSubprofileId!: string | null;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'previous_owner_subprofile_id' })
  previousOwnerSubprofile!: Subprofile | null;

  // When the name was freed.
  @Column({ type: 'timestamptz' })
  releasedAt!: Date;

  // releasedAt + the cooldown window. Before this instant the name is reserved
  // to its previous owner; at/after it, anyone may claim it. Indexed so a future
  // sweep of expired reservations stays cheap.
  @Index('IDX_handle_history_reclaimable_at')
  @Column({ type: 'timestamptz' })
  reclaimableAt!: Date;
}
