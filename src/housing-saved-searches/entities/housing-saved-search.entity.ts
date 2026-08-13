import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { HousingSearchCriteria } from '../housing-search-criteria';

/**
 * A member's named housing search — the structured filter set (as jsonb) plus
 * an `alertsEnabled` flag. When on, a new listing going live is matched against
 * this search and, if it fits, its owner is notified through the existing
 * notifications/push system (see the alerts listener). Kept in its own module,
 * separate from the listings domain it references only by criteria.
 */
@Entity('housing_saved_searches')
export class HousingSavedSearch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // The member who owns this saved search. Indexed for "my saved searches" and
  // for the alerts fan-out's alerts-enabled scan.
  @Index('IDX_housing_saved_searches_member_id')
  @Column({ type: 'uuid' })
  memberId!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  // The saved filter set — the same knobs the directory browse accepts.
  @Column({ type: 'jsonb', default: {} })
  criteria!: HousingSearchCriteria;

  // When true, a new live listing that matches `criteria` notifies this member.
  @Index('IDX_housing_saved_searches_alerts_enabled')
  @Column({ type: 'boolean', default: true })
  alertsEnabled!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
