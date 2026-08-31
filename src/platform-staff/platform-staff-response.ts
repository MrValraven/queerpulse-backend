import { UserRole } from '../users/entities/user.entity';
import { StaffRoleId } from '../users/staff-roles.registry';

/**
 * The account tiers that earn a staff badge. Deliberately narrower than
 * `UserRole` — `member` is everyone else, and publishing it would turn the
 * roster into a full member directory.
 */
export type StaffRole = UserRole.Moderator | UserRole.Admin;

/**
 * Wire shape for one staff member — matches `PlatformStaffRowDTO` in the
 * frontend's `staff.api.ts` exactly. The badge-map consumers (`useStaffMap`)
 * only ever read `slug`/`platformRole`/`badgedStaffRoles`; `firstName`/
 * `lastName` were added for the admin staff-roster page (`/admin/staff`), which
 * needs to say who each row actually is rather than just a handle. Both are
 * already public profile fields shown anywhere a member's name appears, so
 * exposing them for the (small, already user-facing-as-staff) roster is no
 * wider than what any active member can already see on that person's profile.
 *
 * Nothing beyond the slug, the two name fields and the two role fields belongs
 * here. This repo has no global serializer, so the service hand-maps the entity
 * and a column only reaches a member if someone writes it into this shape.
 */
export interface PlatformStaffRowDTO {
  slug: string;
  firstName: string;
  lastName: string;
  /**
   * The badge-earning ACCOUNT tier, or null for a grant holder who sits on the
   * ordinary member tier. Its meaning is unchanged from before grants were
   * rostered: it is still `User.role`, still only ever `moderator` or `admin`,
   * and every row that carried a value before still carries the same one.
   * Null rather than a third `'member'` value on purpose: every existing
   * consumer keys a label, a tone and a badge off this field through a lookup
   * that covers exactly two tiers, and a fourth string flowing into those would
   * fail quietly, while a null is a case each of them has to answer for.
   */
  platformRole: StaffRole | null;
  /**
   * The additive staff grants this person holds that earn a public badge, in
   * registry order (see `hasPublicStaffBadge` in the staff-roles registry for
   * which grants qualify and why two do not). Additive to the field above: a
   * member on the ordinary tier is on the roster BECAUSE of these, and an admin
   * or moderator who also holds one carries their tier and their grants at once.
   * Empty for the many staff who hold no grant at all.
   */
  badgedStaffRoles: StaffRoleId[];
}
