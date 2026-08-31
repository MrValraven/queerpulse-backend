import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import {
  BADGED_STAFF_ROLE_IDS,
  StaffRoleId,
  isBadgedStaffRoleId,
} from '../users/staff-roles.registry';
import { PlatformStaffRowDTO, StaffRole } from './platform-staff-response';

/** The account tiers that earn a staff badge. Plain members are excluded. */
const STAFF_TIERS = [UserRole.Moderator, UserRole.Admin];

@Injectable()
export class PlatformStaffService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(UserStaffRole)
    private readonly staffRoleGrantsRepository: Repository<UserStaffRole>,
  ) {}

  /**
   * The whole staff roster: the moderator and admin account tiers, plus every
   * member holding an additive grant that earns a badge (ENG-28). Before that
   * second population was rostered, someone handed the housing queue or the
   * magazine desk could decline a listing or spike a piece and still appear to
   * the member on the other side of that decision as an ordinary account.
   *
   * Filtered to active users so a suspended or deactivated moderator stops being
   * presented as staff the moment their account changes state, rather than
   * lingering until someone edits a list.
   *
   * THE LIMIT. `DEFAULT_LIST_LIMIT` is the unpaginated-list cap every list
   * endpoint here carries, and widening the population under ONE shared take
   * would have meant a long enough moderator bench silently pushing every grant
   * holder off the end, the exact people this change exists to show. So the cap
   * is applied per population instead: the tiers are capped, the grant rows are
   * capped, and the roster is the union of the two. Both bounds sit far above
   * any plausible real staff, and the grant query is bounded by grant ROWS
   * rather than people, so a handful of members holding several grants each
   * still fits with room to spare.
   */
  async list(): Promise<PlatformStaffRowDTO[]> {
    // Grants first: their holders are half of who the roster has to load, and
    // the same rows also tell us which badges every tier member wears.
    const badgedGrants = await this.staffRoleGrantsRepository.find({
      where: { role: In(BADGED_STAFF_ROLE_IDS) },
      // Deterministic order so the cap, if it were ever reached, would truncate
      // the same way twice rather than shuffling who is on the roster per call.
      order: { userId: 'ASC', role: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });

    const badgedRolesByUserId = new Map<string, StaffRoleId[]>();
    for (const grant of badgedGrants) {
      // `user_staff_roles.role` is a varchar validated at the app layer, so a
      // row written by an older build (or by hand) can hold a string this build
      // does not know. Drop it rather than badge someone with a raw key.
      if (!isBadgedStaffRoleId(grant.role)) continue;
      const held = badgedRolesByUserId.get(grant.userId) ?? [];
      held.push(grant.role);
      badgedRolesByUserId.set(grant.userId, held);
    }
    const grantHolderIds = [...badgedRolesByUserId.keys()];

    // Two `where` objects is an OR: the badge-earning tiers, and the grant
    // holders (who are mostly on the ordinary member tier and so match no tier
    // clause at all). Both arms keep the active-status filter.
    const tierUsers = await this.usersRepository.find({
      where: { role: In(STAFF_TIERS), status: UserStatus.Active },
      relations: { profile: true },
      take: DEFAULT_LIST_LIMIT,
    });
    const grantHolders = grantHolderIds.length
      ? await this.usersRepository.find({
          where: { id: In(grantHolderIds), status: UserStatus.Active },
          relations: { profile: true },
          take: DEFAULT_LIST_LIMIT,
        })
      : [];

    // An admin who also holds a grant matches both queries. Dedupe by user id so
    // they appear once, carrying their tier and their grants together.
    const rosterUsersById = new Map<string, User>();
    for (const rosterUser of [...tierUsers, ...grantHolders]) {
      rosterUsersById.set(rosterUser.id, rosterUser);
    }

    // A user without a profile row has no slug to key the badge by, so there is
    // nothing the frontend could match them against.
    return [...rosterUsersById.values()]
      .filter((staffUser) => staffUser.profile?.slug)
      .map((staffUser) => ({
        slug: staffUser.profile.slug,
        firstName: staffUser.profile.firstName,
        lastName: staffUser.profile.lastName,
        // Null for a grant holder on the ordinary member tier: they are on this
        // roster for what they were handed, and claiming a tier they do not hold
        // would overstate what they can do.
        platformRole: STAFF_TIERS.includes(staffUser.role)
          ? (staffUser.role as StaffRole)
          : null,
        badgedStaffRoles: sortByRegistryOrder(
          badgedRolesByUserId.get(staffUser.id) ?? [],
        ),
      }));
  }
}

/**
 * Registry order, so a person holding several grants reads the same way on
 * every surface and the badge row does not reorder itself between two calls
 * that happened to read the grant rows in a different sequence.
 */
function sortByRegistryOrder(staffRoleIds: StaffRoleId[]): StaffRoleId[] {
  return [...staffRoleIds].sort(
    (first, second) =>
      BADGED_STAFF_ROLE_IDS.indexOf(first) -
      BADGED_STAFF_ROLE_IDS.indexOf(second),
  );
}
