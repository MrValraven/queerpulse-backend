import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { PieceFormat } from './magazine-piece.entity';

/**
 * String-union "enum" stored as `varchar` (repo idiom: no Postgres
 * `CREATE TYPE`). Triage outcome of a pitch sitting in the editor inbox.
 */
export type PitchStatus = 'waiting' | 'maybe' | 'passed' | 'commissioned';

/**
 * A pitch waiting in the editor inbox (spec §3.2). Triage moves `status`
 * from `waiting` to `maybe`/`passed`/`commissioned`; committing a pitch
 * creates a `MagazinePiece` and stamps that piece's `pitchId` back to this
 * row for provenance.
 */
@Entity('magazine_pitch')
export class MagazinePitch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'varchar' })
  from!: string;

  @Column({ type: 'text' })
  note!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  tags!: string[];

  @Column({ type: 'varchar', nullable: true })
  suggestFormat!: PieceFormat | null;

  @Column({ type: 'varchar', default: 'waiting' })
  status!: PitchStatus;

  @Column({ type: 'boolean', default: false })
  fresh!: boolean;

  @Column({ type: 'uuid', nullable: true })
  issueId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  passTemplate!: string | null;

  @Column({ type: 'text', nullable: true })
  passNote!: string | null;

  /**
   * The writer (magazine_writer staff role) who submitted this pitch, so a
   * writer's "your pitches" view (Magazine Desk Phase 6) can be scoped to
   * `submitterId === user.id`. Nullable because pitches can also arrive from
   * outside the platform (`from`) with no linked account.
   */
  @Index('IDX_magazine_pitch_submitter')
  @Column({ type: 'uuid', nullable: true })
  submitterId!: string | null;

  /**
   * The reader story submission this pitch was commissioned FROM
   * (`AdminStorySubmissionsService.decide` with a `commissioned` decision).
   * Null for every pitch that arrived any other way. It is what turns a
   * member's "submit a story" into a row the desk's pitch inbox can act on,
   * and it keeps the provenance so the desk can open the full piece the member
   * actually wrote rather than just the summary carried in `note`.
   */
  @Index('IDX_magazine_pitch_story_submission')
  @Column({ type: 'uuid', nullable: true })
  storySubmissionId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
