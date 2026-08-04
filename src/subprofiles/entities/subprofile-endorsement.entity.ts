import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('subprofile_endorsements')
@Unique('UQ_subprofile_endorsements', ['subprofileId', 'endorserId'])
export class SubprofileEndorsement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_subprofile_endorsements_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId!: string;

  @Index('IDX_subprofile_endorsements_endorser_id')
  @Column({ type: 'uuid' })
  endorserId!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  // Soft-delete: withdrawn rows stay (history) but are excluded from counts/lists. Null = active.
  @Column({ type: 'timestamptz', nullable: true })
  withdrawnAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
