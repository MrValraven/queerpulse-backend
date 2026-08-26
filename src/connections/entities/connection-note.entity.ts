import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One member's PRIVATE note about one of their connections (SOC-14).
 *
 * "Met at the harm-reduction workshop, works nights, hates phone calls" is the
 * kind of thing an address book is for, and it belongs to the person who wrote
 * it alone. The row is therefore keyed by `(connection_id, author_id)`: both
 * parties to a connection may keep a note, neither ever sees the other's.
 *
 * That guarantee is enforced at the READ, not by hoping every call site
 * remembers: `ConnectionsService.viewerNotesByConnectionId` filters on
 * `authorId = <the viewer>`, so a note that is not the viewer's own is never
 * loaded in the first place and cannot reach a response DTO. There is no
 * global serializer in this repo, so a hand-mapped `note` field on
 * `ConnectionListItem` is the only way it is ever emitted.
 */
@Entity('connection_notes')
@Unique('UQ_connection_notes_connection_author', ['connectionId', 'authorId'])
export class ConnectionNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  connectionId!: string;

  // Backs the viewer-scoped read (`author_id = :viewer AND connection_id IN
  // (...)`) that every list page runs.
  @Index('IDX_connection_notes_author_id')
  @Column({ type: 'uuid' })
  authorId!: string;

  // Stored as plain text: markup is stripped once at the write boundary
  // (`toStoredPlainTextOrNull`), never at render.
  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
