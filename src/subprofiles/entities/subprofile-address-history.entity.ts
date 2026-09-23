import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Subprofile } from './subprofile.entity';

/**
 * A persona address that is no longer live: `(previousUserId, slug)` is the
 * old nested link `/members/<previous creator slug>/<slug>`, and
 * `subprofileId` is the persona that used to answer there.
 *
 * Written when the creator role moves to another co-owner
 * (`transferCreatorWithin` in `subprofile-creator-transfer.ts`), so the public
 * read can forward a visitor from the old address to the persona's current
 * one. The public read always looks for a live persona at `(user, slug)` first,
 * so a row here never shadows a persona that holds that address today.
 *
 * One row per old address: a later transfer away from the same
 * `(previousUserId, slug)` upserts onto it and points it at the newer persona.
 * Both foreign keys cascade: an erased previous creator has no profile page to
 * forward from, and a deleted persona has nowhere to forward to. See migration
 * `1821500200000-AddSubprofileAddressHistory`.
 */
@Entity('subprofile_address_history')
@Unique('UQ_subprofile_address_history_user_slug', ['previousUserId', 'slug'])
export class SubprofileAddressHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  previousUserId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'previous_user_id' })
  previousUser!: User;

  @Column({ type: 'varchar' })
  slug!: string;

  @Index('IDX_subprofile_address_history_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subprofile_id' })
  subprofile!: Subprofile;

  @CreateDateColumn({ type: 'timestamptz' })
  movedAt!: Date;
}
