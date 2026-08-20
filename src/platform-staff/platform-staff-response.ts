import { UserRole } from '../users/entities/user.entity';

/**
 * The platform roles that earn a staff badge. Deliberately narrower than
 * `UserRole` — `member` is everyone else, and publishing it would turn the
 * roster into a full member directory.
 */
export type StaffRole = UserRole.Moderator | UserRole.Admin;

/**
 * Wire shape for one staff member — matches `PlatformStaffRowDTO` in the
 * frontend's `staff.api.ts` exactly. The badge-map consumers (`useStaffMap`)
 * only ever read `slug`/`platformRole`; `firstName`/`lastName` were added
 * for the admin staff-roster page (`/admin/staff`), which needs to say who
 * each row actually is rather than just a handle. Both are already public
 * profile fields shown anywhere a member's name appears, so exposing them
 * for the (small, already user-facing-as-staff) roster is no wider than
 * what any active member can already see on that person's profile.
 */
export interface PlatformStaffRowDTO {
  slug: string;
  firstName: string;
  lastName: string;
  platformRole: StaffRole;
}
