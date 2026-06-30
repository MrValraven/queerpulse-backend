import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Profile } from './profile.entity';

export enum UserStatus {
  Pending = 'pending',
  Active = 'active',
  Suspended = 'suspended',
}

export enum UserRole {
  Member = 'member',
  Moderator = 'moderator',
  Admin = 'admin',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  googleId: string;

  @Column({ type: 'varchar', unique: true })
  email: string;

  @Column({
    type: 'enum',
    enum: UserStatus,
    enumName: 'users_status_enum',
    default: UserStatus.Pending,
  })
  status: UserStatus;

  @Column({
    type: 'enum',
    enum: UserRole,
    enumName: 'users_role_enum',
    default: UserRole.Member,
  })
  role: UserRole;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invited_by' })
  invitedBy: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  // Per-user override for the monthly invite quota. NULL means "use the global
  // default" (app.inviteMonthlyQuota, itself defaulting to 1). Set directly in
  // the database to grant a member a higher (or lower) allowance.
  @Column({ type: 'integer', nullable: true })
  inviteMonthlyQuota: number | null;

  @OneToOne(() => Profile, (profile) => profile.user)
  profile: Profile;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
