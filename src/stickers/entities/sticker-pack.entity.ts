import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Sticker } from './sticker.entity';

/**
 * A pack is `draft` while an admin is still filling it, `published` once
 * members may send from it, and `archived` when it is withdrawn. Archiving
 * rather than deleting is the only withdrawal path for a published pack: a
 * message's attachment is baked at send time, so history survives either way,
 * but the rows are what let a report or an export name the sticker later.
 */
export enum StickerPackStatus {
  Draft = 'draft',
  Published = 'published',
  Archived = 'archived',
}

@Entity('sticker_packs')
@Index('IDX_sticker_packs_status_order', ['status', 'sortOrder'])
@Unique('UQ_sticker_packs_slug', ['slug'])
export class StickerPack {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 64 })
  slug!: string;

  @Column({ length: 80 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: StickerPackStatus,
    enumName: 'sticker_packs_status_enum',
    default: StickerPackStatus.Draft,
  })
  status!: StickerPackStatus;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  /** The sticker shown as the pack's tile in the picker rail. Intentionally
   *  not a relation: it points into the child table, and a real foreign key
   *  would make the two tables circular for insert ordering. An unresolvable
   *  cover reads as "no cover" and the first sticker stands in. */
  @Column({ type: 'uuid', nullable: true })
  coverStickerId!: string | null;

  /** The admin who built this pack, or `null` once that admin's account has
   *  been erased. The FK is `ON DELETE SET NULL` for the same reason
   *  `Message.senderId` is (see that column's own doc): a pack's history
   *  must survive erasing whoever created it, never block it with a
   *  restrictive FK. */
  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @OneToMany(() => Sticker, (sticker) => sticker.pack)
  stickers!: Sticker[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
