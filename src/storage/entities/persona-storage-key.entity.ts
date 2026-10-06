import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';
import type { UploadKind } from '../upload-kinds';

/**
 * T17: the persona a persona-scoped storage key (`persona/<uuid>/<uuid><ext>`)
 * was minted for.
 *
 * A persona-scoped key carries no owner segment, so this row is what the
 * storage layer reads in its place:
 * - `GET /files/*` serves a persona-scoped key only while a row names it, and
 *   withholds it while its uploader is suspended (the same media-safety rule
 *   every user-scoped key gets from its middle segment).
 * - `POST /uploads/crop` accepts a persona-scoped key from a member of the
 *   persona named here.
 * - Erasure, the Art. 20 export, My uploads and the admin media console find
 *   a member's persona-scoped objects through `uploaded_by_id`.
 *
 * Both foreign keys live in migration `1830080000000-AddPersonaStorageKeys`.
 * `subprofile_id` cascades on update, so the row follows the persona to the
 * fresh id an unlink gives it (`issueFreshPersonaId`), and on delete, so a
 * deleted persona's keys stop serving at once. `uploaded_by_id` is set null
 * when that account is erased. Neither id reaches a public response.
 */
@Entity('persona_storage_keys')
export class PersonaStorageKey {
  /** Bare persona-scoped key, e.g. `persona/<uuid>/<uuid>.jpg`. */
  @PrimaryColumn({
    type: 'varchar',
    primaryKeyConstraintName: 'PK_persona_storage_keys',
  })
  storageKey!: string;

  @Index('IDX_persona_storage_keys_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_persona_storage_keys_subprofile',
  })
  subprofile?: Subprofile;

  /** The member whose upload (or server-side import) these bytes came from. */
  @Index('IDX_persona_storage_keys_uploaded_by_id')
  @Column({ type: 'uuid', nullable: true })
  uploadedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'uploaded_by_id',
    foreignKeyConstraintName: 'FK_persona_storage_keys_uploaded_by',
  })
  uploadedBy?: User | null;

  /** The upload kind the bytes were first stored as (`avatar`,
   *  `persona-cover`, `work-image`), so My uploads and the export can label
   *  the object. Null when unknown. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  uploadKind!: UploadKind | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
