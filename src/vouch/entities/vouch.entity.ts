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
  id!: string;

  // No standalone index here on purpose: `UQ_vouches_voucher_vouchee` below
  // is a composite unique index on (voucherId, voucheeId), and its leading
  // column already serves any query filtering on voucherId alone (Postgres
  // "Multicolumn Indexes" — a leading-column equality constraint narrows the
  // scan the same way a plain single-column index would). A standalone
  // IDX_vouches_voucher_id previously duplicated that coverage — dropped via
  // DropRedundantVouchVoucherIndex1787600300000.
  @Column({ type: 'uuid' })
  voucherId!: string;

  @Index('IDX_vouches_vouchee_id')
  @Column({ type: 'uuid' })
  voucheeId!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  // The ways the voucher knows this member — one or more of the relationship
  // enum values. Nullable because the signup auto-vouch and legacy rows carry
  // no relationship; a member-initiated vouch always sends at least one.
  @Column({
    type: 'enum',
    enum: VOUCH_RELATIONSHIPS,
    enumName: 'vouches_relationship_enum',
    array: true,
    nullable: true,
  })
  relationships!: VouchRelationship[] | null;

  @Column({ type: 'boolean', default: false })
  anonymous!: boolean;

  // Soft-delete: a withdrawn vouch keeps its row (history + admin graph) but is
  // excluded from every count/list. Null = active.
  @Column({ type: 'timestamptz', nullable: true })
  withdrawnAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
