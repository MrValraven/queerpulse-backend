import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { CropRect } from '../crop-rect';

@Entity('media_crops')
export class MediaCrop {
  /** Bare storage key, e.g. "avatars/<userId>/<uuid>.jpg". */
  @PrimaryColumn('varchar')
  storageKey!: string;

  @Column('uuid')
  ownerId!: string;

  @Column('jsonb')
  crop!: CropRect;

  // Explicit `timestamptz` on both, matching `AddMediaCrops1789400000000` and
  // every other date column in the schema. TypeORM's postgres driver defaults a
  // bare `@CreateDateColumn()`/`@UpdateDateColumn()` to `timestamp without time
  // zone`, so leaving them bare makes the next `migration:generate` emit an
  // `ALTER COLUMN ... TYPE timestamp` that would drop the zone off stored values.
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
