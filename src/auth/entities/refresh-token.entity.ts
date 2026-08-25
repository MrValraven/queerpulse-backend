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
