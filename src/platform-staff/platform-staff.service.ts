import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { PlatformStaffRowDTO, StaffRole } from './platform-staff-response';

/** The roles that earn a staff badge. Plain members are excluded. */
const STAFF_ROLES = [UserRole.Moderator, UserRole.Admin];

@Injectable()
export class PlatformStaffService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /**
   * The whole staff roster. Filtered to active users so a suspended or
   * deactivated moderator stops being presented as staff the moment their
   * account changes state, rather than lingering until someone edits a list.
   */
  async list(): Promise<PlatformStaffRowDTO[]> {
    const staffUsers = await this.usersRepository.find({
      where: { role: In(STAFF_ROLES), status: UserStatus.Active },
      relations: { profile: true },
    });
    // A user without a profile row has no slug to key the badge by, so there is
    // nothing the frontend could match them against.
    return staffUsers
      .filter((staffUser) => staffUser.profile?.slug)
      .map((staffUser) => ({
        slug: staffUser.profile.slug,
        platformRole: staffUser.role as StaffRole,
      }));
  }
}
