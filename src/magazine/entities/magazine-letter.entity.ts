import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A reader letter received about a `MagazinePiece` (spec §7.2 After tab).
 * Many rows per piece — indexed, not unique.
 */
@Entity('magazine_letter')
export class MagazineLetter {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_magazine_letter_piece')
  @Column({ type: 'uuid' })
  pieceId!: string;

  @Column({ type: 'varchar' })
  who!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'boolean', default: false })
  runInLetters!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
