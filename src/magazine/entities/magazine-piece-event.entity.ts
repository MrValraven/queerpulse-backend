import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Audit trail for a piece (spec §3.4). Written on every state change,
 * assignment, publish, or restore. `actorId` is nullable — `null` means the
 * change was made by "System" rather than a user.
 */
@Entity('magazine_piece_event')
export class MagazinePieceEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_magazine_piece_event_piece')
  @Column({ type: 'uuid' })
  pieceId!: string;

  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar' })
  action!: string;

  @Column({ type: 'varchar', nullable: true })
  detail!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
