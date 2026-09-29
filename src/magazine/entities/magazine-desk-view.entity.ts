import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * The desk URL state a saved view restores. Mirrors the query params the
 * editor desk reads (`?track=`, `?focus=`, and the filter/sort/group state in
 * `useDeskState`). Every key is optional: a view stores only what differs
 * from the desk's defaults. The service validates it by hand in
 * `desk-view-query.validation.ts` before every save.
 */
export interface DeskViewQuery {
  track?: string;
  focus?: string[];
  format?: string;
  sections?: string[];
  stages?: string[];
  editor?: string | null;
  sort?: string;
  groupBy?: string;
}

/**
 * One editor's saved desk view: a named snapshot of the desk's filters that
 * they can jump back to. Private to its owner (every read and write is
 * scoped by `ownerId`), so two editors can each keep a "Close week" view.
 *
 * `ownerId` cascades on user delete: a saved view is personal workspace
 * state with no editorial value once its owner is gone.
 */
@Entity('magazine_desk_view')
@Unique('UQ_magazine_desk_view_owner_name', ['ownerId', 'name'])
@Index('IDX_magazine_desk_view_owner_position', ['ownerId', 'position'])
export class MagazineDeskView {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  ownerId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'owner_id',
    foreignKeyConstraintName: 'FK_magazine_desk_view_owner',
  })
  owner!: User;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  @Column({ type: 'jsonb' })
  query!: DeskViewQuery;

  /** Order in the owner's list, lowest first. */
  @Column({ type: 'int' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
