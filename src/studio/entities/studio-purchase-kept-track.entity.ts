import {
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Column,
} from 'typeorm';
import { StudioKeptTrack } from './studio-kept-track.entity';
import { StudioPurchase } from './studio-purchase.entity';

/**
 * Links a confirmed purchase to a kept track it still downloads after the
 * artist persona unlinked. `position` is the track order at unlink. The link
 * leaves with its purchase and with its kept track. Migration
 * `1838000000000-AddStudioPurchases`.
 */
@Entity('studio_purchase_kept_tracks')
@Index('IDX_studio_purchase_kept_tracks_kept_track', ['keptTrackId'])
export class StudioPurchaseKeptTrack {
  @PrimaryColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_purchase_kept_tracks',
  })
  purchaseId!: string;

  @ManyToOne(() => StudioPurchase, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'purchase_id',
    foreignKeyConstraintName: 'FK_studio_purchase_kept_tracks_purchase',
  })
  purchase?: StudioPurchase;

  @PrimaryColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_purchase_kept_tracks',
  })
  keptTrackId!: string;

  @ManyToOne(() => StudioKeptTrack, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'kept_track_id',
    foreignKeyConstraintName: 'FK_studio_purchase_kept_tracks_kept_track',
  })
  keptTrack?: StudioKeptTrack;

  @Column({ type: 'integer' })
  position!: number;
}
