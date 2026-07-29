import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('subprofile_affiliations')
@Unique('UQ_subprofile_affiliations', [
  'subprofileId',
  'targetType',
  'targetSlug',
])
export class SubprofileAffiliation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_subprofile_affiliations_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId: string;

  @Column({ type: 'varchar' })
  targetType: string; // 'event' | 'community'

  @Column({ type: 'varchar' })
  targetSlug: string;

  @Column({ type: 'varchar' })
  role: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
