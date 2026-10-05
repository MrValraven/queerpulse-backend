import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * The kinds of thing that can hold a mailbox and appear as a message sender.
 * `Profile` is a member acting as themselves and every user has exactly one.
 * `Official` is the platform's own QueerPulse Team: exactly one row, owned by
 * no entity (every owner column null), whose mailbox holds the official
 * threads members have replied in and whose staff are the platform's
 * moderators and admins (`OFFICIAL_MAILBOX_STAFF_ROLES`).
 */
export enum IdentityKind {
  Profile = 'profile',
  Subprofile = 'subprofile',
  Listing = 'listing',
  Company = 'company',
  Official = 'official',
}

export type IdentityOwnerColumn =
  'userId' | 'subprofileId' | 'listingId' | 'companyId';

/**
 * One namespace for every sender in messaging, following the shape `handles`
 * already uses: a `kind` discriminator plus mutually exclusive owner columns
 * held apart by a database CHECK. Messaging keys on `identities.id`, so a
 * listing, persona or company can be a participant and a sender while the
 * human behind a message stays recorded on `messages.sender_id`.
 */
@Entity('identities')
export class Identity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_identities_kind')
  @Column({
    type: 'enum',
    enum: IdentityKind,
    enumName: 'identities_kind_enum',
  })
  kind!: IdentityKind;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  subprofileId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  listingId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  companyId!: string | null;

  /**
   * Mailbox-level attribution switch, set by the owner. When true, a staff
   * reply may read "Tiago from Cafe Lisboa", showing a first name only. It is
   * meaningless for `Profile` and ignored there. A staff member may decline
   * naming for themselves in `identity_staff_preferences`, and both switches
   * must allow naming for a name to reach a customer.
   */
  @Column({ type: 'boolean', default: true })
  shouldShowStaffNames!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/** Every kind whose identity row is owned by one entity row. `Official` is
 *  the exception: the one QueerPulse Team identity belongs to the platform. */
export type OwnedIdentityKind = Exclude<IdentityKind, IdentityKind.Official>;

export function isOwnedIdentityKind(
  kind: IdentityKind,
): kind is OwnedIdentityKind {
  return kind !== IdentityKind.Official;
}

export function ownerColumnForKind(
  kind: OwnedIdentityKind,
): IdentityOwnerColumn {
  switch (kind) {
    case IdentityKind.Profile:
      return 'userId';
    case IdentityKind.Subprofile:
      return 'subprofileId';
    case IdentityKind.Listing:
      return 'listingId';
    case IdentityKind.Company:
      return 'companyId';
  }
}
