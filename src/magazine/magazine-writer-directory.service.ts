import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import {
  MagazineEditorResponse,
  toMagazineEditor,
} from './magazine-piece-response';

/**
 * The desk's writer picker: every active member holding the
 * `magazine_writer` staff role, in the same hand-mapped shape as the editor
 * directory (`MagazinePieceService.listMagazineEditors`), so the picker reads
 * one `{ id, name, initials, avatarUrl }` row type for both.
 */
@Injectable()
export class MagazineWriterDirectoryService {
  constructor(
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  /**
   * Active `magazine_writer` grant holders, sorted by name. A suspended or
   * deactivated writer keeps their grant but drops out of the picker, and a
   * writer with no profile row has no name to show, so they drop out too.
   */
  async listMagazineWriters(): Promise<MagazineEditorResponse[]> {
    const grants = await this.staffRoles.find({
      where: { role: 'magazine_writer' },
    });
    const grantedIds = [...new Set(grants.map((grant) => grant.userId))];
    if (grantedIds.length === 0) {
      return [];
    }

    const activeUsers = await this.users.find({
      where: { id: In(grantedIds), status: UserStatus.Active },
      select: { id: true },
    });
    const activeIds = activeUsers.map((user) => user.id);
    if (activeIds.length === 0) {
      return [];
    }

    const profiles = await this.profiles.find({
      where: { userId: In(activeIds) },
    });
    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );

    const writers: MagazineEditorResponse[] = [];
    for (const userId of activeIds) {
      const writer = toMagazineEditor(
        userId,
        profileByUserId.get(userId) ?? null,
      );
      if (writer) {
        writers.push(writer);
      }
    }

    return writers.sort((left, right) => left.name.localeCompare(right.name));
  }
}
