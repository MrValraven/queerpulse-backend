import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * One saved subject filed inside a `collection`. Polymorphic like `saved_item`:
 * `(subjectKind, subjectId)` identify the filed thing without an FK, since the
 * targets span several unrelated domains (articles, films, jobs, posts…). The
 * pair mirrors `saved_item.(subject_type, subject_id)` exactly, so a collection
 * item is hydrated back into its presentational snapshot by looking the owner's
 * matching `saved_item` up on read — the collection stores only the reference,
 * never a second copy of the snapshot.
 *
 * `subjectKind` is a plain `varchar` (not the `saved_item_subject_type_enum`) so
 * collections stay decoupled from the saved-kind enum and never need an enum
 * migration when a new saveable kind is added.
 */
@Entity('collection_item')
@Unique('UQ_collection_item_subject', [
  'collectionId',
  'subjectKind',
  'subjectId',
])
export class CollectionItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_collection_item_collection_id')
  @Column({ type: 'uuid' })
  collectionId!: string;

  @Column({ type: 'varchar' })
  subjectKind!: string;

  @Column({ type: 'varchar' })
  subjectId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
