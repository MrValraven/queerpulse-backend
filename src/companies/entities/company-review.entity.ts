import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('company_reviews')
@Unique('UQ_company_reviews', ['companyId', 'authorId'])
export class CompanyReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_company_reviews_company_id')
  @Column({ type: 'uuid' })
  companyId!: string;

  // Nullable since `SetNullContentAuthorFksOnUserErasure1794610000000`: the FK
  // to `users` was `ON DELETE CASCADE`, so erasing one member's account
  // deleted reviews the next applicant relies on. It is now `ON DELETE SET NULL`, so
  // NULL here means "the review was written by a member who has since left" rather than "no such row".
  // Read paths must render a removed-member placeholder instead of assuming
  // a non-null id. See `ContentOwnerErasureService` for what happens to the
  // row itself when the account goes.
  @Index('IDX_company_reviews_author_id')
  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'int' })
  stars!: number;

  @Column({ type: 'varchar' })
  byline!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  body!: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
