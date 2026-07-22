import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One-row table for the two Change Makers hero stats that cannot be computed
 * from the profiles themselves. `profiled` and `causeAreas` are derived at
 * list time; these two are curated numbers the admin edits. The row is a
 * singleton — always id `SETTINGS_ID`.
 */
export const CHANGEMAKER_SETTINGS_ID = 'default';

@Entity('changemaker_directory_settings')
export class ChangemakerDirectorySettings {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  id: string;

  @Column({ type: 'int', default: 0 })
  peopleHelped: number;

  @Column({ type: 'int', default: 0 })
  activeCampaigns: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
