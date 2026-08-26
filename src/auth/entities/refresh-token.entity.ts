import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_refresh_tokens_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * The SESSION this row belongs to, stable across rotation.
   *
   * A row is a credential and lives ~15 minutes; a session is the whole chain
   * of rows descended from one sign-in. Every rotation carries the family
   * forward, so "sign out this device" and the security page's device list can
   * address the session the member actually recognises rather than whichever
   * token happens to be current. New sign-ins start a new family.
   */
  @Index('IDX_refresh_tokens_family_id')
  @Column({ type: 'uuid' })
  familyId!: string;

  @Index('IDX_refresh_tokens_token_hash', { unique: true })
  @Column({ type: 'varchar' })
  tokenHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  replacedBy!: string | null;

  @Column({ type: 'varchar', nullable: true })
  userAgent!: string | null;

  /**
   * The coarse, human-readable name of the device this session runs on —
   * "Chrome on macOS", "Safari on iPhone" — derived once at mint time by
   * `deviceLabelFromUserAgent` and carried unchanged through every rotation.
   *
   * It exists because `userAgent` alone cannot answer the only question the
   * security page is for. A member scanning `Mozilla/5.0 (Macintosh; Intel Mac
   * OS X 10_15_7) AppleWebKit/537.36 …` cannot tell their own laptop from
   * somebody else's, so the raw string was doing the work of a device name
   * while being unreadable as one.
   *
   * It is also the RECOGNITION KEY: `AuthService.issueTokens` asks whether this
   * user has any earlier row with the same label before deciding that a sign-in
   * is from a new device. That is why the label is deliberately coarse and
   * version-free (see `device-label.ts`) — a label carrying a browser version
   * would change on every update and alert the member about their own laptop.
   *
   * NULLABLE for the rows that predate this column, which have a `userAgent`
   * but never had a label derived. `listSessions` and the recognition check
   * both read a NULL as "no label on record" rather than as a device name.
   */
  @Column({ type: 'varchar', length: 120, nullable: true })
  deviceLabel!: string | null;

  /**
   * The last time this SESSION was seen, stamped at sign-in and again at every
   * rotation.
   *
   * `createdAt` on the newest row in a family already approximates this, and
   * `AccountService.listSessions` reads it that way today — but only by
   * knowing that rotation mints a row, which is an implementation detail of the
   * credential store leaking into a member-facing "last seen". Naming the value
   * gives the security page a column that means what it says, and gives a
   * future non-rotation touchpoint somewhere to stamp without minting a row.
   *
   * Coarse by nature either way: an idle tab refreshes on its own schedule, so
   * this trails real activity by up to one access-token lifetime.
   *
   * NULLABLE for rows that predate the column; readers fall back to `createdAt`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  /**
   * When the SESSION began, carried forward unchanged through every rotation.
   *
   * `createdAt` is when this particular token was minted, which for an active
   * device is never more than one refresh ago. Reporting that as "signed in"
   * told members their oldest device had just appeared.
   */
  @Column({ type: 'timestamptz' })
  sessionStartedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
