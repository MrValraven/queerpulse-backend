import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Run-order entry for the issue-production page (Magazine Desk Phase 5):
 * which piece runs in this slot and its planned page range. Order in the
 * array IS the running order; resolved against `magazine_piece` by
 * `pieceId` in the service layer.
 */
export interface IssueRunOrderItem {
  pieceId: string;
  pages: string;
}

/**
 * Members' digest entry for the issue-production page (Magazine Desk
 * Phase 5): the editorial blurb for a piece and whether it is included
 * (`on`) in the digest/social send.
 */
export interface IssueDigestItem {
  pieceId: string;
  blurb: string;
  on: boolean;
}

/**
 * A quarterly print/digital issue (`IssuesPage.tsx`'s `ISSUES` array). `number`
 * is the zero-padded display number ("01".."09") the FE links to — it acts as
 * the public identifier (`GET /magazine/issues/:number`), not `id`.
 */
@Entity('magazine_issue')
export class MagazineIssue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_magazine_issue_number', { unique: true })
  @Column({ type: 'varchar' })
  number!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  dek!: string;

  // Postgres `date` — TypeORM returns this as a plain `YYYY-MM-DD` string,
  // matching `IssueResponse.publishedOn: string` with no extra conversion.
  @Column({ type: 'date' })
  publishedOn!: string;

  @Column({ type: 'varchar', nullable: true })
  coverUrl!: string | null;

  /** "Issue N · theme" on the production header (Magazine Desk Phase 5). */
  @Column({ type: 'varchar', default: '' })
  theme!: string;

  /** Running order for issue production (Magazine Desk Phase 5). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  runOrder!: IssueRunOrderItem[];

  /** Members' digest / social curation (Magazine Desk Phase 5). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  digest!: IssueDigestItem[];

  /** Cover coverlines (Magazine Desk Phase 5) — distinct from headlines. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  coverlines!: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
