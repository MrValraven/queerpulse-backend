import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
