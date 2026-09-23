import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { StickerPack } from './sticker-pack.entity';

/** Search terms per language, used by the picker. Stored rather than derived
 *  so an admin can add the words a flag is actually looked up by. */
export interface StickerKeywords {
  en: string[];
  pt: string[];
}

@Entity('stickers')
@Index('IDX_stickers_pack_order', ['packId', 'sortOrder'])
@Unique('UQ_stickers_pack_slug', ['packId', 'slug'])
export class Sticker {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  packId!: string;

  @ManyToOne(() => StickerPack, (pack) => pack.stickers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'pack_id' })
  pack!: StickerPack;

  @Column({ length: 64 })
  slug!: string;

  /** The human name, e.g. "Bi reverse". Used as the image's alt text, the
   *  reply-quote line, and the starred snippet. */
  @Column({ length: 80 })
  label!: string;

  /** The 512px PNG's private storage key, resolved through `toImageUrl` to
   *  `GET /files/<key>` at every read path, exactly like every other image
   *  field in this app. */
  @Column({ length: 512 })
  storageKey!: string;

  @Column({ type: 'int' })
  width!: number;

  @Column({ type: 'int' })
  height!: number;

  /** The artwork as standalone SVG markup: the re-editable source of truth.
   *  Stored here rather than in the bucket because the upload content-type
   *  allow-list admits no SVG and serving one from `GET /files/*` would let
   *  it execute its own script in a member's tab. */
  @Column({ type: 'text' })
  svgSource!: string;

  @Column({ length: 64 })
  templateId!: string;

  /** The exact template inputs that produced `svgSource`, so a later change
   *  to the template can re-render this sticker without an admin rebuilding
   *  it by hand. */
  @Column({ type: 'jsonb' })
  templateParams!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => `'{"en":[],"pt":[]}'` })
  keywords!: StickerKeywords;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
