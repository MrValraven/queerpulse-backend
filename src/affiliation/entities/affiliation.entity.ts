import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum AffiliationStatus {
  Pending = 'pending',
  Active = 'active',
}

/**
 * "I work at company X" — a member's self-declared employer affiliation
 * (plan Task 2.4; spec §3 Tier 2 "affiliation"). Backs the FE's
 * `EmployerAffiliationDTO` (`features/economy/api/affiliation.api.ts`),
 * whose own comment says it all: "Which company the current member is
 * authorised to post jobs for. A member has at most one affiliation; it
 * starts `pending` while the platform confirms the employer relationship,
 * then flips to `active`."
 *
 * At most one row per user (`UQ_affiliations_user_id`) — re-`POST`ing
 * replaces the existing row rather than adding a second. `status` is
 * derived server-side (never caller-supplied): `active` when the user
 * already owns the company or is on its `company_team_members` roster, the
 * same test `CompaniesService#getCompanyForJobPosting` uses to authorize job
 * posting; `pending` otherwise.
 */
@Entity('affiliations')
export class Affiliation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_affiliations_user_id', { unique: true })
  @Column({ type: 'uuid' })
  userId: string;

  @Index('IDX_affiliations_company_id')
  @Column({ type: 'uuid' })
  companyId: string;

  @Column({ type: 'varchar' })
  role: string;

  @Column({
    type: 'enum',
    enum: AffiliationStatus,
    enumName: 'affiliation_status_enum',
    default: AffiliationStatus.Pending,
  })
  status: AffiliationStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
