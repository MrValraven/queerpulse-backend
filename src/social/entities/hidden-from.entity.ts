import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A one-way "hide my profile from this one person" preference placed by
 * `ownerId` against `hiddenFromUserId` (member profile v2 Task 5). Distinct
 * from `Block` (see `block.entity.ts`): no notification to either side, no
 * severance of an existing connection, and narrower in effect — the target
 * simply can't find `ownerId` in directory search or by direct profile URL;
 * everything else (messaging, feeds, connections) is unaffected.
 */
@Entity('hidden_from_members')
@Unique('UQ_hidden_from_pair', ['ownerId', 'hiddenFromUserId'])
@Index('IDX_hidden_from_viewer', ['hiddenFromUserId', 'ownerId'])
export class HiddenFromMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'uuid' })
  hiddenFromUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
