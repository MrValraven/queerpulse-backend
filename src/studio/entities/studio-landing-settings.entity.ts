import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * The single settings row of the Studio page (contract 6.5). Reads treat a
 * missing row as a visible founding shelf.
 */
@Entity('studio_landing_settings')
@Check('CHK_studio_landing_settings_single_row', '"id" = 1')
export class StudioLandingSettings {
  @PrimaryColumn({
    type: 'smallint',
    default: 1,
    primaryKeyConstraintName: 'PK_studio_landing_settings',
  })
  id!: number;

  @Column({ type: 'boolean', default: true })
  isFoundingShelfVisible!: boolean;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'updated_by_id',
    foreignKeyConstraintName: 'FK_studio_landing_settings_updated_by',
  })
  updatedBy?: User | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  updatedAt!: Date;
}
