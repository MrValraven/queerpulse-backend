import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * One moderator question — and the submitter's optional answer — in a
 * listing's Q&A conversation thread (item #17), surfaced in the admin
 * drawer via `GET /listings/admin/:ref/history`.
 *
 * A row is created by `ListingsService.askQuestion` alongside the existing
 * DM delivery to the submitter (the DM stays the actual notification
 * channel; this row is the queryable record the history endpoint reads).
 * `answer`/`answeredAt` are populated by the listing owner via the
 * owner-gated `POST /listings/:ref/questions/:id/answer`
 * (`ListingsService.answerQuestion`) — both null until answered.
 *
 * `listingId` follows the same deliberate no-FK-to-`listings` convention as
 * `ListingModerationEvent.listingId` (see that entity's doc comment, and
 * `ListingReview.listingId`'s precedent). `askedBy` is the moderator who
 * asked; nullable + `ON DELETE SET NULL` mirrors
 * `ListingModerationEvent.actorId`'s user-reference convention.
 */
@Entity('listing_questions')
export class ListingQuestion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_listing_questions_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  @Column({ type: 'uuid', nullable: true })
  askedBy!: string | null;

  // FK to `users(id)` ON DELETE SET NULL — see the class doc comment.
  @Index('IDX_listing_questions_asked_by')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'asked_by' })
  asker!: User | null;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'text', nullable: true })
  answer!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  answeredAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
