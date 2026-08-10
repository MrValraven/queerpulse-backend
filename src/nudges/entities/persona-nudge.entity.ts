import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// One row per (user, nudge) the caller has dismissed for good — backs the
// "fires at most once, cap at 2 dismissals, cross-device" rule for the six
// persona discovery moments (Personas Phase 5). `nudgeKey` is one of the
// fixed `NUDGE_KEYS` (validated in `NudgesService.dismiss`, not enforced by a
// DB enum, so a new moment never needs a migration).
// `UQ_persona_nudges_user_id_nudge_key` makes a dismiss idempotent at the DB
// level (a repeat POST is absorbed via `ON CONFLICT DO NOTHING`, see
// `NudgesService.dismiss`); the leading `user_id` index backs both
// `GET /nudges/me` (this user's dismissed keys) and the cap check
// (COUNT(*) for this user).
@Entity('persona_nudges')
@Unique('UQ_persona_nudges_user_id_nudge_key', ['userId', 'nudgeKey'])
export class PersonaNudge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_persona_nudges_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  nudgeKey!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  dismissedAt!: Date;
}
