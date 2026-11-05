import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Subprofile } from './subprofile.entity';

/**
 * Persona wall: one persona an admin hand-picked for the wall on the People
 * Directory hero. At most 9 rows exist. `position` is unique and DEFERRABLE
 * INITIALLY IMMEDIATE, so a reorder or a remove rewrites positions in one
 * statement. The unique on `subprofile_id` doubles as its index. A deleted
 * persona takes its pick with it (cascade), and an unlink deletes the pick in
 * the unlink transaction so a wall slot never follows a persona to its fresh
 * id. `added_by_id` stays off every wire. Migration
 * `1839000000000-AddPersonaWall`.
 */
@Entity('persona_wall_picks')
@Unique('UQ_persona_wall_picks_subprofile', ['subprofileId'])
@Unique('UQ_persona_wall_picks_position', ['position'], {
  deferrable: 'INITIALLY IMMEDIATE',
})
@Check('CHK_persona_wall_picks_position', `"position" >= 1`)
export class PersonaWallPick {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_persona_wall_picks',
  })
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_persona_wall_picks_subprofile',
  })
  subprofile?: Subprofile;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'uuid', nullable: true })
  addedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'added_by_id',
    foreignKeyConstraintName: 'FK_persona_wall_picks_added_by',
  })
  addedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
