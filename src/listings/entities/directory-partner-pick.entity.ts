import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Listing } from './listing.entity';

/**
 * Directory partners: one business an admin hand-picked for the row at the
 * top of the public directory, with an optional one-line note. At most 12
 * rows exist. `position` is unique and DEFERRABLE INITIALLY IMMEDIATE, so a
 * reorder or a remove rewrites positions in one statement. The unique on
 * `listing_id` doubles as its index. A listing deleted by staff takes its
 * pick with it (cascade). `created_by_id` stays off every wire. Migration
 * `1838700000000-AddDirectoryPartnerPicks`.
 */
@Entity('directory_partner_picks')
@Unique('UQ_directory_partner_picks_listing', ['listingId'])
@Unique('UQ_directory_partner_picks_position', ['position'], {
  deferrable: 'INITIALLY IMMEDIATE',
})
@Check('CHK_directory_partner_picks_position', `"position" >= 1`)
export class DirectoryPartnerPick {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_directory_partner_picks',
  })
  id!: string;

  @Column({ type: 'uuid' })
  listingId!: string;

  @ManyToOne(() => Listing, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'listing_id',
    foreignKeyConstraintName: 'FK_directory_partner_picks_listing',
  })
  listing?: Listing;

  @Column({ type: 'varchar', length: 140, nullable: true })
  note!: string | null;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_directory_partner_picks_created_by',
  })
  createdBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
