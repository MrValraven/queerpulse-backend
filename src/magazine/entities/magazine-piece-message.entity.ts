import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One message in a per-piece editor↔writer thread (Magazine Desk Phase 7,
 * Task F1). Visible/postable ONLY to the piece's assigned editor/admin or its
 * assigned writer — enforced server-side in `MagazinePieceService`'s
 * `assertPieceThreadAccess`, never by this entity or the schema. No `FOREIGN
 * KEY` on `pieceId`: mirrors `MagazineArticleComment`/`MagazineArticleVersion`
 * — a plain indexed `uuid` column, not a TypeORM relation.
 */
@Entity('magazine_piece_message')
export class MagazinePieceMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_magazine_piece_message_piece')
  @Column({ type: 'uuid' })
  pieceId!: string;

  // FK-backed as of `AddMagazineDeskAuthorForeignKeys1795810000000` with `ON
  // DELETE CASCADE`, matching `messages.sender_id`: this thread is private
  // correspondence between the piece's editor and its writer, so an erased
  // member's messages go with them rather than staying readable by whoever the
  // piece is reassigned to. Stays NOT NULL, which is what `fromMe` compares.
  @Index('IDX_magazine_piece_message_author_id')
  @Column({ type: 'uuid' })
  authorId!: string;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
