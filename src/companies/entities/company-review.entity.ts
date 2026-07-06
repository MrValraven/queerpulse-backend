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
  id: string;

  @Index('IDX_company_reviews_company_id')
  @Column({ type: 'uuid' })
  companyId: string;

  @Index('IDX_company_reviews_author_id')
  @Column({ type: 'uuid' })
  authorId: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'int' })
  stars: number;

  @Column({ type: 'varchar' })
  byline: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  body: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
