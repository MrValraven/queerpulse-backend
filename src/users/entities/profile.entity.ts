import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

export enum ProfileVisibility {
  Open = 'open',
  Network = 'network',
  Private = 'private',
}

@Entity('profiles')
export class Profile {
  // user_id is BOTH the primary key and the FK to users (1:1).
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @OneToOne(() => User, (user) => user.profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', unique: true })
  slug: string;

  @Column({ type: 'varchar' })
  firstName: string;

  @Column({ type: 'varchar' })
  lastName: string;

  @Column({ type: 'varchar', nullable: true })
  pronouns: string | null;

  @Column({ type: 'varchar', nullable: true })
  tagline: string | null;

  @Column({ type: 'text', nullable: true })
  bio: string | null;

  @Column({ type: 'varchar', nullable: true })
  location: string | null;

  @Column({ type: 'varchar', nullable: true })
  avatarUrl: string | null;

  @Column({
    type: 'enum',
    enum: ProfileVisibility,
    enumName: 'profiles_visibility_enum',
    default: ProfileVisibility.Open,
  })
  visibility: ProfileVisibility;

  @Column({ type: 'text', array: true, default: '{}' })
  openTo: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
