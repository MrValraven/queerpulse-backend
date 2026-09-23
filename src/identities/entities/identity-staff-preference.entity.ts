import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A staff member's own answer to "may my name appear on replies I send from
 * this mailbox". A row exists only once someone changes the default, so an
 * absent row means naming is allowed. Naming still requires the mailbox
 * owner's `identities.should_show_staff_names` to be on.
 */
@Entity('identity_staff_preferences')
@Unique('UQ_identity_staff_preferences', ['identityId', 'userId'])
export class IdentityStaffPreference {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  identityId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'boolean', default: true })
  shouldAllowNaming!: boolean;
}
