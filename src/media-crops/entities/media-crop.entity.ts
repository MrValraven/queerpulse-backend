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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
