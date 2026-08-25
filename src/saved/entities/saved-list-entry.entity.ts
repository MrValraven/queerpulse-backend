import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { SavedItem } from './saved-item.entity';
import { SavedList } from './saved-list.entity';

/**
 * One saved item's membership of one list. A join table, deliberately, rather
 * than a `list_id` column on `saved_item`.
 *
 * AN ITEM CAN BELONG TO MORE THAN ONE LIST, and this is the decision the shape
 * encodes. A `list_id` column would have been smaller and would have been
 * wrong: a late-opening bar that is also somewhere you would take a first date
 * is genuinely both, and a single-parent model forces the member to pick, or to
 * save the same venue twice and then keep two copies in step by hand. The
 * clinic somebody puts in "trans-friendly healthcare" is the same clinic they
 * put in "near me", and the whole value of the second list is that it contains
 * things already in the first one. Multi-membership also keeps the invariant
 * the default list depends on: everything saved is in the default list AND in
 * whatever else the member filed it under.
 *
 * The cost is one join table and a uniqueness constraint, which is cheap. The
 * cost of the alternative is a member's curation quietly destroying itself.
 *
 * BOTH FKs CASCADE. Deleting a list drops its memberships and leaves the items
 * saved; unsaving an item drops it from every list it was in. Neither direction
 * can leave a dangling row, and neither is a soft state worth preserving:
 * a membership of a list that no longer exists means nothing.
 */
@Entity('saved_list_entries')
@Unique('UQ_saved_list_entries_pair', ['listId', 'savedItemId'])
// Backs the reverse lookup ("which of my lists is this item in?") and the
// cascade from `saved_item`.
@Index('IDX_saved_list_entries_saved_item_id', ['savedItemId'])
export class SavedListEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_saved_list_entries_list_id')
  @Column({ type: 'uuid' })
  listId!: string;

  // Both relations are declared alongside their scalars so entity metadata and
  // the migration-owned schema agree — see `SavedList.user` for the rationale.
  @ManyToOne(() => SavedList, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'list_id' })
  list!: SavedList;

  @Column({ type: 'uuid' })
  savedItemId!: string;

  @ManyToOne(() => SavedItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'saved_item_id' })
  savedItem!: SavedItem;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
