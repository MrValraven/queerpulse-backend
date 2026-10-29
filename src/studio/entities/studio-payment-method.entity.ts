import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';

export enum StudioPaymentMethodKind {
  Link = 'link',
  Mbway = 'mbway',
  Iban = 'iban',
}

/**
 * A way to pay one artist persona: a payment link, an MB WAY number or an
 * IBAN, shown to a buyer who is about to pay the artist directly.
 * QueerPulse holds no money. A persona keeps up to eight methods in
 * `position` 0 to 7. `subprofile_id` cascades on delete and update, so the
 * methods leave with their persona. Migration
 * `1838000000000-AddStudioPurchases`.
 */
@Entity('studio_payment_methods')
@Check('CHK_studio_payment_methods_position', '"position" BETWEEN 0 AND 7')
@Index(
  'UQ_studio_payment_methods_subprofile_position',
  ['subprofileId', 'position'],
  { unique: true },
)
export class StudioPaymentMethod {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_payment_methods',
  })
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_payment_methods_subprofile',
  })
  subprofile?: Subprofile;

  @Column({
    type: 'enum',
    enum: StudioPaymentMethodKind,
    enumName: 'studio_payment_method_kind',
  })
  kind!: StudioPaymentMethodKind;

  /** Optional name the artist gives the method; an empty label stores null. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  label!: string | null;

  /** The payment link, MB WAY number or IBAN, in canonical form. */
  @Column({ type: 'varchar', length: 500 })
  value!: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  note!: string | null;

  @Column({ type: 'smallint' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
