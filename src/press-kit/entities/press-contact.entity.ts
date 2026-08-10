import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One admin-curated press contact / team member shown on the public
 * `/about/press-kit` page — who a journalist can reach out to. Ordered by
 * `position` and filtered to `active` on the public read; the admin surface
 * sees every row (active AND inactive).
 */
@Entity('press_contact')
@Index('IDX_press_contact_active_position', ['active', 'position'])
export class PressContact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar' })
  role!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'varchar' })
  languages!: string;

  @Column({ type: 'varchar' })
  email!: string;

  @Column({ type: 'varchar', nullable: true })
  avatarUrl!: string | null;

  @Column({ type: 'int', default: 0 })
  position!: number;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
