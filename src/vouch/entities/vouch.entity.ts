import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type VouchRelationship =
  'collaborated' | 'friends' | 'group' | 'met_through' | 'neighbours';

export const VOUCH_RELATIONSHIPS: VouchRelationship[] = [
  'collaborated',
  'friends',
  'group',
  'met_through',
  'neighbours',
];

@Entity('vouches')
@Unique('UQ_vouches_voucher_vouchee', ['voucherId', 'voucheeId'])
export class Vouch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_vouches_voucher_id')
  @Column({ type: 'uuid' })
  voucherId: string;

  @Index('IDX_vouches_vouchee_id')
  @Column({ type: 'uuid' })
  voucheeId: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({
    type: 'enum',
    enum: VOUCH_RELATIONSHIPS,
    enumName: 'vouches_relationship_enum',
    nullable: true,
  })
  relationship: VouchRelationship | null;

  @Column({ type: 'boolean', default: false })
  anonymous: boolean;

  // Soft-delete: a withdrawn vouch keeps its row (history + admin graph) but is
  // excluded from every count/list. Null = active.
  @Column({ type: 'timestamptz', nullable: true })
  withdrawnAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
