import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';

// Which kind of owner a registry row points at. The CHECK constraint (authored
// in the migration) enforces that exactly one of `userId`/`subprofileId` is set
// to match the kind. See design plan PART C / UC2.
export enum HandleOwnerKind {
  Profile = 'profile',
  Subprofile = 'subprofile',
}

/**
 * The `handles` registry — the single source of truth for the ONE global
 * username namespace (design plan PART C / UC2). Every main-profile username and
 * every published unlinked-subprofile handle occupies exactly one row here, so a
 * handle can never collide with any username or another handle: the PK on `name`
 * enforces global uniqueness across both owner kinds at once.
 *
 * `name` is already normalized (trimmed + lowercased via `normalizeHandle`)
 * before it ever reaches this table.
 */
@Entity('handles')
export class Handle {
  // The normalized handle, PRIMARY KEY — this is what makes the namespace global.
  @PrimaryColumn({ type: 'varchar' })
  name: string;

  @Column({
    type: 'enum',
    enum: HandleOwnerKind,
    enumName: 'handles_owner_kind_enum',
  })
  ownerKind: HandleOwnerKind;

  // Set when ownerKind === 'profile'; null otherwise (enforced by the migration
  // CHECK constraint). Cascades so a deleted user frees the handle.
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  // Set when ownerKind === 'subprofile'; null otherwise. Cascades so a deleted
  // subprofile frees the handle.
  @Column({ type: 'uuid', nullable: true })
  subprofileId: string | null;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subprofile_id' })
  subprofile: Subprofile | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
