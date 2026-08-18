import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// A work item's optional link: either an in-app cross-reference to another
// entity (community, event, etc. — `entity` names which, `slug` addresses it)
// or an arbitrary external URL. Discriminated by `kind`, mirroring the
// `OpenToEntry`-style union in `open-to.ts`. See `WorkLinkDto` for the
// class-validator shape that arrives over the wire.
export type WorkLink =
  | { kind: 'ref'; entity: string; slug: string }
  | { kind: 'external'; href: string };

@Entity('work_items')
export class WorkItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_work_items_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  category!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'varchar' })
  year!: string;

  @Column({ type: 'varchar', nullable: true })
  imageUrl!: string | null;

  @Column({ type: 'int', default: 0 })
  position!: number;

  // 0-2 entries, enforced by `WorkLinkDto`'s `@ArrayMaxSize(2)` — not at the
  // DB level. Never queried/filtered on, so no GIN index.
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  links!: WorkLink[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
