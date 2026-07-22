import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProfilesService } from '../profiles/profiles.service';
import { ReplaceGroupsDto } from '../profiles/dto/replace-groups.dto';
import { ReplaceShapingsDto } from '../profiles/dto/replace-shapings.dto';
import { ReplaceSkillsDto } from '../profiles/dto/replace-skills.dto';
import { ReplaceSocialsDto } from '../profiles/dto/replace-socials.dto';
import { ReplaceWorkDto } from '../profiles/dto/replace-work.dto';
import { UpdateProfileDto } from '../profiles/dto/update-profile.dto';
import { UpdateUsernameDto } from '../profiles/dto/update-username.dto';
import { User } from '../users/entities/user.entity';
import { AdminBotSummary, toBotSummary } from './admin-bots-response';

/**
 * Admin surface for editing platform system accounts (currently only the
 * QueerPulse house account). Every write is gated on `isSystem === true`, so an
 * admin can NEVER reach a real member's profile through here — that is the
 * authorization boundary. Field validation is entirely reused: each method
 * delegates to the same `ProfilesService` method the owner's own
 * `profiles/me/*` route uses, keyed by the target account's `userId`.
 */
@Injectable()
export class AdminBotsService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly profiles: ProfilesService,
  ) {}

  async listBots(): Promise<AdminBotSummary[]> {
    const systemAccounts = await this.users.find({
      where: { isSystem: true },
      relations: { profile: true },
    });
    return systemAccounts.map(toBotSummary);
  }

  // Returns the userId after asserting the target exists AND is a system
  // account. A non-system or missing target is a 404 (not a 403): the surface
  // does not admit that any given id is a real member.
  private async requireSystemAccount(userId: string): Promise<string> {
    const target = await this.users.findOne({ where: { id: userId } });
    if (!target || !target.isSystem) {
      throw new NotFoundException('System account not found');
    }
    return target.id;
  }

  async updateBotProfile(userId: string, dto: UpdateProfileDto) {
    return this.profiles.updateMe(await this.requireSystemAccount(userId), dto);
  }

  async updateBotUsername(userId: string, dto: UpdateUsernameDto) {
    return this.profiles.updateUsername(
      await this.requireSystemAccount(userId),
      dto.username,
    );
  }

  async replaceBotSocials(userId: string, dto: ReplaceSocialsDto) {
    return this.profiles.replaceSocials(
      await this.requireSystemAccount(userId),
      dto.items,
    );
  }

  async replaceBotWork(userId: string, dto: ReplaceWorkDto) {
    return this.profiles.replaceWork(
      await this.requireSystemAccount(userId),
      dto.items,
    );
  }

  async replaceBotSkills(userId: string, dto: ReplaceSkillsDto) {
    return this.profiles.replaceSkills(
      await this.requireSystemAccount(userId),
      dto.items,
    );
  }

  async replaceBotShapings(userId: string, dto: ReplaceShapingsDto) {
    return this.profiles.replaceShapings(
      await this.requireSystemAccount(userId),
      dto.items,
    );
  }

  async replaceBotGroups(userId: string, dto: ReplaceGroupsDto) {
    return this.profiles.replaceGroups(
      await this.requireSystemAccount(userId),
      dto.items,
    );
  }
}
