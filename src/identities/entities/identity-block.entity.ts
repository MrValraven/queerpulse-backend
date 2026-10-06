import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A member blocking a business, persona or company. This is deliberately a
 * separate table from `blocks`, which stays a user-to-user pair under
 * `UQ_blocks_pair`. Blocking Cafe Lisboa leaves its owner's personal account
 * reachable, and blocking that person leaves the business thread open,
 * because those are two different relationships.
 *
 * A row is either a direct block of an identity (`identityId`) or a block
 * carried across a persona going unlinked (`blockedSubprofileId`,
 * `retiredIdentityId`, `blockedNameSnapshot`); `CHK_identity_blocks_target`
 * holds every row to exactly one of the two.
 */
@Entity('identity_blocks')
@Unique('UQ_identity_blocks_pair', ['blockerUserId', 'identityId'])
@Index(
  'UQ_identity_blocks_carried_pair',
  ['blockerUserId', 'retiredIdentityId'],
  {
    unique: true,
    where: '"retired_identity_id" IS NOT NULL',
  },
)
export class IdentityBlock {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_identity_blocks_blocker_user_id')
  @Column({ type: 'uuid' })
  blockerUserId!: string;

  /** The identity blocked. Null on a carried block (ENG-447), whose
   *  persona's identity was retired when the persona went unlinked. */
  @Index('IDX_identity_blocks_identity_id')
  @Column({ type: 'uuid', nullable: true })
  identityId!: string | null;

  /**
   * ENG-447, a carried block: the persona whose identity the member blocked
   * before the persona went unlinked. The block refuses whichever identity
   * the persona speaks through now. Follows the persona to the fresh id the
   * unlink gives it (`ON UPDATE CASCADE`). Null on a direct block.
   */
  @Index('IDX_identity_blocks_blocked_subprofile_id')
  @Column({ type: 'uuid', nullable: true })
  blockedSubprofileId!: string | null;

  /** ENG-447, a carried block: the retired identity the member blocked. The
   *  id their Blocked list shows and unblock takes. Null on a direct block. */
  @Column({ type: 'uuid', nullable: true })
  retiredIdentityId!: string | null;

  /** ENG-447, a carried block: the named persona's name at the unlink, the
   *  only name the Blocked list shows for the row. Null on a direct block. */
  @Column({ type: 'varchar', nullable: true })
  blockedNameSnapshot!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
