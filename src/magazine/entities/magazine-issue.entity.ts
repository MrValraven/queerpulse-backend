import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A quarterly print/digital issue (`IssuesPage.tsx`'s `ISSUES` array). `number`
 * is the zero-padded display number ("01".."09") the FE links to — it acts as
 * the public identifier (`GET /magazine/issues/:number`), not `id`.
 */
@Entity('magazine_issue')
export class MagazineIssue {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_magazine_issue_number', { unique: true })
  @Column({ type: 'varchar' })
  number: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  dek: string;

  // Postgres `date` — TypeORM returns this as a plain `YYYY-MM-DD` string,
  // matching `IssueResponse.publishedOn: string` with no extra conversion.
  @Column({ type: 'date' })
  publishedOn: string;

  @Column({ type: 'varchar', nullable: true })
  coverUrl: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
