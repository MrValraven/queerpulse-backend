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
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

@ApiTags('Subprofiles')
@ApiCookieAuth()
@Controller('subprofiles')
export class SubprofilesController {
  constructor(private readonly subprofilesService: SubprofilesService) {}

  // --- literal routes first, so 'mine'/'directory'/'by-handle' are never
  //     captured by the ':id' param route below. ----------------------------

  @Get('mine')
  @ApiOperation({ summary: 'List the current member’s own subprofiles' })
  @ApiOkResponse({ description: 'The member’s subprofiles (owner-facing view).' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.subprofilesService.listMine(user.userId);
  }

  @Get('directory')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Browse the public subprofile directory' })
  @ApiOkResponse({ description: 'Directory cards matching the query.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  directory(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListDirectoryQuery,
  ) {
    return this.subprofilesService.directory(query, user.userId);
  }

  @Get('by-handle/:handle')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Get a published subprofile by its handle (public view)' })
  @ApiOkResponse({ description: 'The subprofile’s public view.' })
  @ApiNotFoundResponse({ description: 'No published subprofile with that handle.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
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
  @ApiOperation({ summary: 'List every crawlable persona handle (public, for sitemap/prerender)' })
  @ApiOkResponse({ description: 'All published persona handles.' })
  listPublicHandles() {
    return this.subprofilesService.listPublicHandles();
  }

  @Post()
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Create a subprofile' })
  @ApiCreatedResponse({ description: 'The newly created subprofile (owner-facing view).' })
  @ApiBadRequestResponse({ description: 'Invalid field (e.g. unknown accent, CTA pairing).' })
  @ApiConflictResponse({ description: 'Slug or handle already in use.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateSubprofileDTO,
  ) {
    return this.subprofilesService.create(user.userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your own subprofiles by id' })
  @ApiOkResponse({ description: 'The subprofile (owner-facing view).' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  getOne(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.getOwnedDTO(user.userId, id);
  }

  @Patch(':id')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Update a subprofile’s core fields' })
  @ApiOkResponse({ description: 'The updated subprofile (owner-facing view).' })
  @ApiBadRequestResponse({ description: 'Invalid field (e.g. unknown accent, CTA pairing).' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiConflictResponse({ description: 'Slug or handle already in use.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: UpdateSubprofileDTO,
  ) {
    return this.subprofilesService.update(user.userId, id, dto);
  }

  @Put(':id/sections/:section')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Replace all items in one section of a subprofile' })
  @ApiOkResponse({ description: 'The updated subprofile (owner-facing view).' })
  @ApiBadRequestResponse({ description: 'Unknown section, or invalid items (e.g. multiple featured).' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
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
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Replace a subprofile’s social links' })
  @ApiOkResponse({ description: 'The updated subprofile (owner-facing view).' })
  @ApiBadRequestResponse({ description: 'Invalid social links.' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
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
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Replace a subprofile’s event/community affiliations' })
  @ApiOkResponse({ description: 'The updated subprofile (owner-facing view).' })
  @ApiBadRequestResponse({ description: 'Invalid affiliations.' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
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
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Publish a subprofile' })
  @ApiCreatedResponse({ description: 'The published subprofile (owner-facing view).' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnprocessableEntityResponse({
    description: 'The persona is not ready to publish (unmet requirements or the handle was just taken).',
  })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  publish(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.publish(user.userId, id);
  }

  @Post(':id/unpublish')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Unpublish a subprofile back to draft' })
  @ApiCreatedResponse({ description: 'The unpublished subprofile (owner-facing view).' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  unpublish(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.unpublish(user.userId, id);
  }

  @Delete(':id')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Delete a subprofile' })
  @ApiOkResponse({ description: '`{ ok: true }` once deleted.' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
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
  @ApiOperation({ summary: 'Endorse a subprofile (optionally with a note)' })
  @ApiCreatedResponse({ description: 'The updated endorsement standing.' })
  @ApiBadRequestResponse({ description: 'You cannot endorse your own persona.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  endorse(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: EndorseDTO,
  ) {
    return this.subprofilesService.endorse(user.userId, id, dto.note);
  }

  @UseGuards(ActiveMemberGuard)
  @Delete(':id/endorse')
  @ApiOperation({ summary: 'Withdraw your endorsement of a subprofile' })
  @ApiOkResponse({ description: 'The updated endorsement standing.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  withdrawEndorsement(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
  ) {
    return this.subprofilesService.withdrawEndorsement(user.userId, id);
  }

  @UseGuards(ActiveMemberGuard)
  @Get(':id/endorsements')
  @ApiOperation({ summary: 'List a subprofile’s endorsers' })
  @ApiOkResponse({ description: 'The endorsers of the subprofile.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  listEndorsers(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.listEndorsers(user.userId, id);
  }

  // --- followers — sit after the endorsement routes, before the class ends;
  //     same reason those do: ':id' above must not shadow these literals. ---

  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':id/follow')
  @ApiOperation({ summary: 'Follow a subprofile' })
  @ApiCreatedResponse({ description: 'The updated follow standing.' })
  @ApiBadRequestResponse({ description: 'You cannot follow your own persona.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  follow(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.follow(user.userId, id);
  }

  @UseGuards(ActiveMemberGuard)
  @Delete(':id/follow')
  @ApiOperation({ summary: 'Unfollow a subprofile' })
  @ApiOkResponse({ description: 'The updated follow standing.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  unfollow(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.subprofilesService.unfollow(user.userId, id);
  }
}

// The `GET /profiles/:slug/subprofiles` route belongs to the subprofiles
// domain but is mounted under `profiles` (it lists a member's linked+published
// personas). Declared as a separate controller in this file, mirroring how
// `profiles.controller.ts` co-locates `MembersController`.
@ApiTags('Subprofiles')
@ApiCookieAuth()
@Controller('profiles')
export class ProfileSubprofilesController {
  constructor(private readonly subprofilesService: SubprofilesService) {}

  @Get(':slug/subprofiles')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'List a member’s linked, published subprofiles' })
  @ApiOkResponse({ description: 'The member’s public subprofiles.' })
  @ApiNotFoundResponse({ description: 'No member with that slug.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  listForProfile(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.subprofilesService.listForProfile(slug, user.userId);
  }
}
