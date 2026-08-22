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
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
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
    @InjectRepository(Profile)
    private readonly profileRows: Repository<Profile>,
    @InjectRepository(WorkItem)
    private readonly workItems: Repository<WorkItem>,
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

  async updateBotProfile(
    requesterUserId: string,
    userId: string,
    dto: UpdateProfileDto,
  ) {
    const botUserId = await this.requireSystemAccount(userId);
    // Runs BEFORE delegating the write: any admin may re-save the avatar
    // another admin sourced for the shared house account, but may not point it
    // at a NEW foreign upload (see `assertNoForeignUploadIntroduced`). The
    // interceptor has already collapsed any `/files/<key>` URL to its bare key,
    // matching the bare key stored on the profile row.
    const storedProfile = await this.profileRows.findOne({
      where: { userId: botUserId },
    });
    assertNoForeignUploadIntroduced(requesterUserId, dto.avatarUrl, [
      storedProfile?.avatarUrl,
    ]);
    return this.profiles.updateMe(botUserId, dto);
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

  async replaceBotWork(
    requesterUserId: string,
    userId: string,
    dto: ReplaceWorkDto,
  ) {
    const botUserId = await this.requireSystemAccount(userId);
    // Runs BEFORE the replace: an admin may keep a work-item image another
    // admin sourced, but may not introduce a foreign upload the account does
    // not already hold. Each incoming item is checked against the whole set of
    // currently stored work-item images (a full replace, so order is
    // irrelevant to whether an image is "already stored").
    const storedWorkItems = await this.workItems.find({
      where: { userId: botUserId },
    });
    const storedImages = storedWorkItems.map((workItem) => workItem.imageUrl);
    for (const item of dto.items) {
      assertNoForeignUploadIntroduced(
        requesterUserId,
        item.imageUrl,
        storedImages,
      );
    }
    return this.profiles.replaceWork(botUserId, dto.items);
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
