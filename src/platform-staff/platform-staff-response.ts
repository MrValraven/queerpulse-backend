import { UserRole } from '../users/entities/user.entity';

/**
 * The platform roles that earn a staff badge. Deliberately narrower than
 * `UserRole` — `member` is everyone else, and publishing it would turn the
 * roster into a full member directory.
 */
export type StaffRole = UserRole.Moderator | UserRole.Admin;

/**
 * Wire shape for one staff member — matches `PlatformStaffRowDTO` in the
 * frontend's `staff.api.ts` exactly. Intentionally just the slug and the role:
 * the frontend keys a lookup map by slug and renders a label, so anything more
 * would be handing out account state no badge needs.
 */
export interface PlatformStaffRowDTO {
  slug: string;
  platformRole: StaffRole;
}
