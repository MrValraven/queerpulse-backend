import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';

export enum StudioSpotlightArtistSlot {
  ArtistOfTheMonth = 'artist_of_the_month',
  NewStars = 'new_stars',
}

/**
 * Studio spotlight curation: one row is one persona in one Studio home
 * spotlight slot. Artist of the month holds 1 and New stars holds 12; the
 * service enforces both capacities. `(slot, position)` is unique and
 * DEFERRABLE INITIALLY IMMEDIATE, so a reorder writes in one statement. The
 * persona key cascades on delete and on update (a persona unlink re-keys the
 * persona; `forgetDiscoveryTiesOfPersona` deletes its rows first).
 * `created_by_id` stays off the member wire. Migration
 * `1838300000000-AddStudioSpotlightArtists`.
 */
@Entity('studio_spotlight_artists')
@Unique('UQ_studio_spotlight_artists_slot_subprofile', ['slot', 'subprofileId'])
@Unique('UQ_studio_spotlight_artists_slot_position', ['slot', 'position'], {
  deferrable: 'INITIALLY IMMEDIATE',
})
@Check('CHK_studio_spotlight_artists_position', '"position" >= 1')
@Index('IDX_studio_spotlight_artists_subprofile_id', ['subprofileId'])
export class StudioSpotlightArtist {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_spotlight_artists',
  })
  id!: string;

  @Column({
    type: 'enum',
    enum: StudioSpotlightArtistSlot,
    enumName: 'studio_spotlight_slot',
  })
  slot!: StudioSpotlightArtistSlot;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_spotlight_artists_subprofile',
  })
  subprofile?: Subprofile;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'varchar', length: 140, nullable: true })
  note!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_studio_spotlight_artists_created_by',
  })
  createdBy?: User | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  createdAt!: Date;
}
