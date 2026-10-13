import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Studio v1: the persona a Studio audio key (`studio-audio/<uuid>/<uuid><ext>`)
 * was presigned for. The key itself names nobody, so this row is what the
 * track confirm reads to prove a key belongs to the release's persona, and
 * what a persona delete reads to remove the persona's audio objects.
 *
 * `subprofile_id` cascades on update (an unlink re-keys the persona) and on
 * delete. `uploaded_by_id` is set null when that account is erased. Neither
 * id reaches a response. Migration `1830900000000-AddStudio`.
 */
@Entity('studio_audio_uploads')
export class StudioAudioUpload {
  @PrimaryColumn({
    type: 'varchar',
    primaryKeyConstraintName: 'PK_studio_audio_uploads',
  })
  storageKey!: string;

  @Index('IDX_studio_audio_uploads_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_audio_uploads_subprofile',
  })
  subprofile?: Subprofile;

  @Index('IDX_studio_audio_uploads_uploaded_by_id')
  @Column({ type: 'uuid', nullable: true })
  uploadedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'uploaded_by_id',
    foreignKeyConstraintName: 'FK_studio_audio_uploads_uploaded_by',
  })
  uploadedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
