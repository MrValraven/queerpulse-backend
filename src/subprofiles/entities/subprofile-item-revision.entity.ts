import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per saved snapshot of a `SubprofileItem` (Protect Your Work,
 * revision history). `snapshot` holds the full item payload as it existed at
 * save time so a member can view or restore a prior version. Pruned to a
 * bounded number of rows per item by `SubprofilesService` (retention prune);
 * this table has no retention constraint of its own.
 */
@Entity('subprofile_item_revisions')
export class SubprofileItemRevision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_subprofile_item_revisions_item_id')
  @Column({ type: 'uuid' })
  itemId!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @Column({ type: 'varchar' })
  section!: string;

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
