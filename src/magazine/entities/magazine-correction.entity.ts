import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A published correction against a `MagazinePiece` (spec §7.2 After tab).
 * Many rows per piece — indexed, not unique.
 */
@Entity('magazine_correction')
export class MagazineCorrection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_magazine_correction_piece')
  @Column({ type: 'uuid' })
  pieceId!: string;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'date', nullable: true })
  publishedOn!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
