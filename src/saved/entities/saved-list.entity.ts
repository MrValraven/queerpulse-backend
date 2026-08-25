import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * A member's named collection of saved things: "first date", "trans-friendly
 * healthcare", "open after midnight".
 *
 * Saving used to be one flat set, which is fine for remembering a thing and
 * useless for the way people actually use it. The lists above are the reason
 * somebody saves a venue at all, and they are also the single most useful thing
 * one queer person can hand another who has just moved to the city.
 *
 * ONE DEFAULT LIST PER MEMBER (`is_default`, partial-unique per user). It is
 * created on first save and holds EVERYTHING the member has saved, so
 * `GET /me/saved` and the default list always agree and no saved item can end
 * up belonging to no list at all. Every other list is a curated subset. This is
 * also what made the backfill honest: every pre-existing saved item was put in
 * its owner's default list, so nothing that was saved before lists existed
 * became invisible after.
 *
 * SHARING IS OFF BY DEFAULT AND EXPLICIT. `share_token` is NULL until the owner
 * asks for a link, and `DELETE /me/saved/lists/:id/share` sets it back to NULL,
 * which kills every copy of the URL already in the world. That design is not
 * politeness. A list of queer venues is a record of where a person goes, and on
 * this platform that can out somebody, so it follows
 * `calendar_feed_tokens` exactly: a STORED random secret rather than a
 * signature derived from the member's id, so one member can revoke one leaked
 * link without a platform-wide secret rotation, and so the URL never contains
 * their internal uuid. The shared read discloses the list's name and its items
 * and nothing whatsoever about who owns it.
 */
@Entity('saved_lists')
// Two lists called "Bars" would be a naming accident, never an intention.
@Index('UQ_saved_lists_user_name', ['userId', 'name'], { unique: true })
// Exactly one default list per member. Partial, so the many non-default lists
// do not collide with each other.
@Index('UQ_saved_lists_user_default', ['userId'], {
  unique: true,
  where: `"is_default" = true`,
})
// The share link's only credential, so it must resolve to at most one list.
// Partial, so every unshared list (NULL token) is exempt.
@Index('UQ_saved_lists_share_token', ['shareToken'], {
  unique: true,
  where: `"share_token" IS NOT NULL`,
})
export class SavedList {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_saved_lists_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  // FK to `users(id)` ON DELETE CASCADE. The relation is declared alongside the
  // scalar so entity metadata and the migration-owned schema agree and
  // `migration:generate` will not propose dropping the constraint (the same
  // reason `ListingClaim` keeps its `claimant` relation).
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  /** The member's "everything I saved" list. Created on first save, holds every
   *  saved item, and cannot be deleted or have items removed from it directly
   *  (unsaving the item is what removes it). */
  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  /** 32 random bytes, hex-encoded (64 chars), or NULL when the list is private.
   *  NULL is the default and the state every list starts in. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  shareToken!: string | null;

  /** When the current link was minted, so the owner can see how long a list has
   *  been shareable. Cleared together with `shareToken` on revoke. */
  @Column({ type: 'timestamptz', nullable: true })
  sharedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
