import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A member-named grouping of saved items (P2-11 "Collections"). Distinct from
 * `saved_item`, which stores the individual bookmarks: a collection is a folder
 * a member creates and drops saves into. Membership lives in the
 * `collection_item` join (one row per saved subject in the collection).
 *
 * Owner-scoped: every read/write is filtered by `ownerId`, so a collection is
 * only ever visible to its creator. `emoji`/`cover` are optional presentation
 * chrome the member can attach (a folder glyph or a cover colour/image key).
 */
@Entity('collection')
export class Collection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_collection_owner_id')
  @Column({ type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  emoji!: string | null;

  @Column({ type: 'varchar', nullable: true })
  cover!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
