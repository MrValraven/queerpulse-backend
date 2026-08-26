import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Postgres `numeric` round-trips as a string through `pg` (arbitrary
 * precision, so the driver never silently narrows it). This keeps
 * `hoursContributed` a `number | null` on the entity, so
 * `opportunity-response.ts` never has to coerce a string. Mirrors `Job`'s
 * identical file-local transformer.
 */
const numericTransformer = {
  to: (value: number | null | undefined): number | null => value ?? null,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

export enum SignupStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

@Entity('volunteer_signups')
@Unique('UQ_volunteer_signups', ['opportunityId', 'userId'])
export class VolunteerSignup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_volunteer_signups_opportunity_id')
  @Column({ type: 'uuid' })
  opportunityId!: string;

  @Index('IDX_volunteer_signups_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'enum', enum: SignupStatus, default: SignupStatus.Pending })
  status!: SignupStatus;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  /**
   * THE COMPLETION RECORD (SUS-05). All four columns are written together by
   * one guarded UPDATE in `VolunteeringService.confirmCompletion` and are
   * never written anywhere else, so they are either all null (nothing
   * recorded yet) or all set. `AddVolunteerSignupCompletion1795600000000`
   * enforces that as a CHECK constraint, and carries the reasoning.
   *
   * Only an ACCEPTED signup can be completed, and only the opportunity's
   * poster or an organiser of the community it is attributed to may confirm
   * it (the same tier `assertCanManageApplicants` applies to accepting an
   * applicant). Hours are therefore attested by a third party rather than
   * self-declared, which is what makes the platform-wide total worth
   * reporting to a funder.
   */

  /** Did they turn up. `false` is a real recorded answer, not "unknown". */
  @Column({ type: 'boolean', nullable: true })
  attended!: boolean | null;

  /**
   * Hours contributed for this session, 0..24, quarter-hour resolution. Zero
   * for a no-show. Bound by a DB CHECK as well as by
   * `CompleteSignupDto`, because a future admin console writing straight to
   * the table must not be able to enter a number a funder would be shown.
   */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  hoursContributed!: number | null;

  /**
   * The idempotency marker and the period key the hours aggregate groups on.
   * `WHERE completed_at IS NULL` in the claiming UPDATE is what makes a second
   * confirmation a no-op instead of a double count.
   *
   * Indexed by `IDX_volunteer_signups_completed_at`, which is PARTIAL
   * (`WHERE completed_at IS NOT NULL`) and therefore declared in the
   * migration rather than with an `@Index` decorator here: confirmed rows are
   * a small minority of the table and the aggregate read never asks for the
   * nulls.
   */
  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  /**
   * Who attested it. Nullable and `ON DELETE SET NULL`: erasing the
   * confirmer's account unlinks the name and leaves the hours standing, since
   * the contribution belonged to the volunteer. Read paths must render a
   * removed-member placeholder rather than assume a non-null id.
   */
  @Column({ type: 'uuid', nullable: true })
  completedById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
