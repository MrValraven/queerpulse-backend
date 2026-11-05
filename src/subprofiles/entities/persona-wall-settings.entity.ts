import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  DEFAULT_PERSONA_WALL_FILL_ORDER,
  PersonaWallFillOrder,
} from '../persona-wall.constants';

/**
 * Persona wall settings: a single row (`id = 1`) that holds how the wall fills
 * after the hand-picked personas. The migration inserts no row; a missing row
 * reads as the default fill order and the first save upserts `id = 1`.
 * Migration `1839000000000-AddPersonaWall`.
 */
@Entity('persona_wall_settings')
@Check('CHK_persona_wall_settings_singleton', `"id" = 1`)
@Check(
  'CHK_persona_wall_settings_fill_order',
  `"fill_order" IN ('endorsed', 'followed', 'newest', 'daily_shuffle')`,
)
export class PersonaWallSettings {
  @PrimaryColumn({
    type: 'smallint',
    primaryKeyConstraintName: 'PK_persona_wall_settings',
  })
  id!: number;

  @Column({
    type: 'varchar',
    length: 20,
    default: DEFAULT_PERSONA_WALL_FILL_ORDER,
  })
  fillOrder!: PersonaWallFillOrder;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'updated_by_id',
    foreignKeyConstraintName: 'FK_persona_wall_settings_updated_by',
  })
  updatedBy?: User | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
