import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type GuideRatingValue = 'helpful' | 'not_helpful';

/**
 * One member's helpful/not-helpful vote on one guide section, addressed by
 * `contentKey` (the i18n dot-path prefix already used to render that section,
 * e.g. `legal.workplace.dismissal` — see `CreateResourceGuideRating
 * 1793000100000`). Upsert-toggle: `ResourceGuideRatingsService.rate()` is the
 * only writer — voting the same `value` again deletes the row (clear),
 * voting a different `value` updates it (change), mirrors
 * `forum-post-vote.entity.ts`'s toggle pattern.
 */
@Entity('resource_guide_rating')
@Index(
  'UQ_resource_guide_rating_content_key_member_id',
  ['contentKey', 'memberId'],
  { unique: true },
)
export class ResourceGuideRating {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  contentKey!: string;

  @Column({ type: 'uuid' })
  memberId!: string;

  @Column({ type: 'varchar' })
  value!: GuideRatingValue;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
