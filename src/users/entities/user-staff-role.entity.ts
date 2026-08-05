import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from './user.entity';

/**
 * One additive staff-role grant held by a member. Grant = a row here; revoke =
 * delete it. `role` is a varchar validated at the app layer against
 * STAFF_ROLES (not a PG enum, so a future role needs no migration). Orthogonal
 * to User.role, which stays the account tier.
 */
@Entity('user_staff_roles')
@Unique(['userId', 'role'])
export class UserStaffRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column('varchar')
  role!: string;

  @Column('uuid', { nullable: true })
  grantedById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  grantedAt!: Date;
}
