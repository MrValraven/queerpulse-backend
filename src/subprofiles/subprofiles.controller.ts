import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CreateSubprofileDTO } from './dto/create-subprofile.dto';
import { EndorseDTO } from './dto/endorse.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';
import { ReplaceAffiliationsDTO } from './dto/replace-affiliations.dto';
import { ReplaceItemsDTO } from './dto/replace-items.dto';
import { ReplaceSocialLinksDTO } from './dto/replace-social-links.dto';
import { UpdateSubprofileDTO } from './dto/update-subprofile.dto';
import { SubprofilesService } from './subprofiles.service';

@Controller('subprofiles')
export class SubprofilesController {
  constructor(private readonly subprofilesService: SubprofilesService) {}

  // --- literal routes first, so 'mine'/'directory'/'by-handle' are never
  //     captured by the ':id' param route below. ----------------------------

  @Get('mine')
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.subprofilesService.listMine(user.userId);
  }

  @Get('directory')
  @UseGuards(ActiveMemberGuard)
  directory(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListDirectoryQuery,
  ) {
    return this.subprofilesService.directory(query, user.userId);
  }

  @Get('by-handle/:handle')
  @UseGuards(ActiveMemberGuard)
  getByHandle(
    @CurrentUser() user: CurrentUserData,
    @Param('handle') handle: string,
  ) {
    return this.subprofilesService.getByHandle(handle, user.userId);
  }

  // Public, unauthenticated: every crawlable persona handle, for the sitemap
  // generator + the Playwright prerenderer (no class guard on this
  // controller, so `@Public()` alone is enough to bypass the global JWT
  // guard — mirrors `DirectoryController` in `listings/directory.controller.ts`).
  @Public()
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get('public-handles')
  listPublicHandles() {
    return this.subprofilesService.listPublicHandles();
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateSubprofileDTO,
  ) {
    return this.subprofilesService.create(user.userId, dto);
  }

  @Get(':id')
  getOne(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.getOwnedDTO(user.userId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: UpdateSubprofileDTO,
  ) {
    return this.subprofilesService.update(user.userId, id, dto);
  }

  @Put(':id/sections/:section')
  replaceSection(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Param('section') section: string,
    @Body() dto: ReplaceItemsDTO,
  ) {
    return this.subprofilesService.replaceSection(
      user.userId,
      id,
      section,
      dto.items,
    );
  }

  @Put(':id/social-links')
  replaceSocialLinks(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: ReplaceSocialLinksDTO,
  ) {
    return this.subprofilesService.replaceSocialLinks(
      user.userId,
      id,
      dto.items,
    );
  }

  @Put(':id/affiliations')
  replaceAffiliations(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: ReplaceAffiliationsDTO,
  ) {
    return this.subprofilesService.replaceAffiliations(
      user.userId,
      id,
      dto.items,
    );
  }

  @Post(':id/publish')
  publish(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.publish(user.userId, id);
  }

  @Post(':id/unpublish')
  unpublish(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.unpublish(user.userId, id);
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.subprofilesService.remove(user.userId, id);
    return { ok: true };
  }

  // --- endorsements — sit below every literal route above; ':id' captures
  //     anything not already matched, so these must stay last. -------------

  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':id/endorse')
  endorse(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: EndorseDTO,
  ) {
    return this.subprofilesService.endorse(user.userId, id, dto.note);
  }

  @UseGuards(ActiveMemberGuard)
  @Delete(':id/endorse')
  withdrawEndorsement(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
  ) {
    return this.subprofilesService.withdrawEndorsement(user.userId, id);
  }

  @UseGuards(ActiveMemberGuard)
  @Get(':id/endorsements')
  listEndorsers(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.listEndorsers(user.userId, id);
  }

  // --- followers — sit after the endorsement routes, before the class ends;
  //     same reason those do: ':id' above must not shadow these literals. ---

  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':id/follow')
  follow(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.follow(user.userId, id);
  }

  @UseGuards(ActiveMemberGuard)
  @Delete(':id/follow')
  unfollow(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.unfollow(user.userId, id);
  }
}

// The `GET /profiles/:slug/subprofiles` route belongs to the subprofiles
// domain but is mounted under `profiles` (it lists a member's linked+published
// personas). Declared as a separate controller in this file, mirroring how
// `profiles.controller.ts` co-locates `MembersController`.
@Controller('profiles')
export class ProfileSubprofilesController {
  constructor(private readonly subprofilesService: SubprofilesService) {}

  @Get(':slug/subprofiles')
  @UseGuards(ActiveMemberGuard)
  listForProfile(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.subprofilesService.listForProfile(slug, user.userId);
  }
}
