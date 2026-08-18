import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ApiCookieAuth,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { HiddenFromService } from './hidden-from.service';

/**
 * "Hide my profile from one person" (member profile v2 Task 5) — a new,
 * distinct safety primitive from `blocks`/`mutes`: one-way, silent (no
 * notification), and narrower in effect (search + direct profile URL only).
 * Always-on, like `BlocksController`/`MutesController`: no `@Feature` flag.
 * Members are addressed by slug in the path, matching those controllers.
 *
 * Nested under `profiles/me` (rather than a top-level `hidden-from`
 * resource) because this is exclusively a self-service setting on the
 * caller's own profile — there is no third-party read of someone else's
 * hidden-from list, unlike blocks/mutes which expose a directional
 * `GET :slug` status check.
 *
 * Builds its own `MemberLookup` from an injected `Repository<Profile>`
 * (available via `UsersModule`, which `SocialModule` already imports and
 * re-exports `TypeOrmModule` from) rather than importing `ProfilesModule` —
 * `ProfilesModule` imports `SocialModule` for `BlockFilterService`, so
 * importing it back here would be a cycle (same reasoning as
 * `SocialService`'s own `MemberLookup` usage and `SocialModule`'s docstring).
 */
@ApiTags('Hidden-from')
@ApiCookieAuth()
@Controller('profiles/me/hidden-from')
@UseGuards(ActiveMemberGuard)
export class HiddenFromController {
  private readonly memberLookup: MemberLookup;

  constructor(
    private readonly hiddenFrom: HiddenFromService,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {
    this.memberLookup = new MemberLookup(this.profiles);
  }

  @Get()
  @ApiOperation({
    summary: 'List members you currently hide your profile from',
  })
  @ApiOkResponse({
    description: '`{ userId, slug, firstName, lastName }[]`, newest first.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async list(@CurrentUser() user: CurrentUserData) {
    const rows = await this.hiddenFrom.list(user.userId);
    const members = await this.memberLookup.byUserIds(
      rows.map((row) => row.hiddenFromUserId),
    );
    // A row whose target profile no longer exists (deleted account) has
    // nothing to look up — drop it rather than surface a half-populated
    // entry the frontend can't render.
    return rows.flatMap((row) => {
      const member = members.get(row.hiddenFromUserId);
      if (!member) return [];
      return [
        {
          userId: row.hiddenFromUserId,
          slug: member.slug,
          firstName: member.firstName,
          lastName: member.lastName,
        },
      ];
    });
  }

  /** Idempotent: hiding from an already-hidden-from member is a no-op. */
  @Post(':slug')
  @ApiOperation({
    summary: 'Hide your profile from a member, by slug (idempotent)',
  })
  @ApiOkResponse({ description: '`{ hidden: true }`.' })
  @ApiBadRequestResponse({ description: 'You cannot hide from yourself.' })
  @ApiNotFoundResponse({ description: 'No member with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async hide(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    const targetUserId = await this.resolveSlug(slug);
    await this.hiddenFrom.hide(user.userId, targetUserId);
    return { hidden: true };
  }

  @Delete(':slug')
  @ApiOperation({ summary: 'Stop hiding your profile from a member, by slug' })
  @ApiOkResponse({ description: '`{ hidden: false }`.' })
  @ApiNotFoundResponse({
    description: 'No member with that slug, or not currently hidden from them.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async unhide(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    const targetUserId = await this.resolveSlug(slug);
    await this.hiddenFrom.unhide(user.userId, targetUserId);
    return { hidden: false };
  }

  private async resolveSlug(slug: string): Promise<string> {
    const targetUserId = await this.memberLookup.userIdForSlug(slug);
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }
    return targetUserId;
  }
}
