import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CoopJoinRequest } from './coop-join-request.entity';

export enum HousingPhase {
  Forming = 'forming',
  Legal = 'legal',
  Finance = 'finance',
  Property = 'property',
  Daily = 'daily',
}

export enum CoopCtaKind {
  Join = 'join',
  Updates = 'updates',
  Mentor = 'mentor',
}

export interface CoopFace {
  initials: string;
  tint: 'coral' | 'jade' | 'plum';
}

@Entity('housing_coops')
export class HousingCoop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_housing_coops_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true })
  nameEm: string | null;

  @Column({ type: 'varchar' })
  city: string;

  @Column({ type: 'varchar' })
  area: string;

  @Column({ type: 'int', default: 0 })
  householdCount: number;

  @Column({
    type: 'enum',
    enum: HousingPhase,
    enumName: 'housing_coops_phase_enum',
    default: HousingPhase.Forming,
  })
  phase: HousingPhase;

  @Column({ type: 'int', default: 0 })
  progress: number;

  @Column({ type: 'boolean', default: false })
  operational: boolean;

  @Column({ type: 'date', nullable: true })
  operationalSince: string | null;

  @Column({ type: 'date', nullable: true })
  formingSince: string | null;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'int', nullable: true })
  shareAmountEuros: number | null;

  @Column({ type: 'int', nullable: true })
  monthlyEuros: number | null;

  @Column({ type: 'boolean', default: false })
  sharesAreTarget: boolean;

  @Column({
    type: 'enum',
    enum: CoopCtaKind,
    enumName: 'housing_coops_cta_kind_enum',
    default: CoopCtaKind.Join,
  })
  ctaKind: CoopCtaKind;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  faces: CoopFace[];

  @Column({ type: 'boolean', default: false })
  published: boolean;

  @OneToMany(() => CoopJoinRequest, (request) => request.coop)
  joinRequests: CoopJoinRequest[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
