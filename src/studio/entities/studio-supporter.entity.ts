import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';

/**
 * A member's opt-in to show as a supporter of one artist persona. The member
 * is shown as their account (`shownAsSubprofileId` is null) or as another
 * persona they belong to; the check constraint refuses the artist persona
 * itself.
 */
@Entity('studio_supporters')
@Check(
  'CHK_studio_supporters_shown_as_other',
  '"shown_as_subprofile_id" IS NULL OR "shown_as_subprofile_id" <> "subprofile_id"',
)
@Index('IDX_studio_supporters_subprofile', ['subprofileId'])
@Index('IDX_studio_supporters_shown_as', ['shownAsSubprofileId'], {
  where: '"shown_as_subprofile_id" IS NOT NULL',
})
export class StudioSupporter {
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_studio_supporters' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_supporters_user',
  })
  user?: User;

  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_studio_supporters' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_supporters_subprofile',
  })
  subprofile?: Subprofile;

  @Column({ type: 'uuid', nullable: true })
  shownAsSubprofileId!: string | null;

  @ManyToOne(() => Subprofile, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({
    name: 'shown_as_subprofile_id',
    foreignKeyConstraintName: 'FK_studio_supporters_shown_as_subprofile',
  })
  shownAs?: Subprofile | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  updatedAt!: Date;
}
