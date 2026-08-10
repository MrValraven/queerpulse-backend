import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
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
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { CreateSubprofileDTO } from './dto/create-subprofile.dto';
import { EndorseDTO } from './dto/endorse.dto';
import { InviteCollaboratorDTO } from './dto/invite-collaborator.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';
import { ReplaceAffiliationsDTO } from './dto/replace-affiliations.dto';
import { ReplaceItemsDTO } from './dto/replace-items.dto';
import { ReplaceSocialLinksDTO } from './dto/replace-social-links.dto';
import { UpdateSubprofileDTO } from './dto/update-subprofile.dto';
import { SubprofileInvitesService } from './subprofile-invites.service';
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
  constructor(
    private readonly subprofilesService: SubprofilesService,
    private readonly subprofileInvitesService: SubprofileInvitesService,
  ) {}

  // --- literal routes first, so 'mine'/'directory'/'by-handle' are never
  //     captured by the ':id' param route below. ----------------------------

  @Get('mine')
  @ApiOperation({ summary: 'List the current member’s own subprofiles' })
  @ApiOkResponse({
    description: 'The member’s subprofiles (owner-facing view).',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.subprofilesService.listMine(user.userId);
  }

  @Get('directory')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Browse the public subprofile directory' })
  @ApiOkResponse({ description: 'Directory cards matching the query.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  directory(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListDirectoryQuery,
  ) {
    return this.subprofilesService.directory(query, user.userId);
  }

  // Public, best-effort auth: `@Public()` lifts the global mandatory JWT guard
  // and `OptionalJwtAuthGuard` attaches `req.user` when a valid session cookie
  // is present, but never rejects an anonymous caller (mirrors
  // `IntakesController`'s `POST /intakes/:kind`). Needed so a signed-out
  // visitor on a `network` persona gets `403 { restrictedState: "members_only" }`
  // instead of a blanket 401 — the owner-only/private protections aren't
  // weakened, `SubprofilesService.buildPublicView` still gates every
  // non-owner viewer (Personas redesign Phase 1b Task 1).
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get('by-handle/:handle')
  @ApiOperation({
    summary: 'Get a subprofile by its handle (public view)',
  })
  @ApiOkResponse({ description: 'The subprofile’s public view.' })
  @ApiForbiddenResponse({
    description:
      'Restricted — response body is `{ restrictedState: "private" | "members_only" | "removed" }`.',
  })
  @ApiNotFoundResponse({
    description:
      'No subprofile with that handle, or an unpublished draft viewed by a non-owner.',
  })
  getByHandle(
    @CurrentUser() user: CurrentUserData | undefined,
    @Param('handle') handle: string,
  ) {
    return this.subprofilesService.getByHandle(handle, user);
  }

  // Public, unauthenticated: every crawlable persona handle, for the sitemap
  // generator + the Playwright prerenderer (no class guard on this
  // controller, so `@Public()` alone is enough to bypass the global JWT
  // guard — mirrors `DirectoryController` in `listings/directory.controller.ts`).
  // Same response for every anonymous caller, so it also carries a positive
  // `Cache-Control` — see AUDIT-2026-07-30.md §I "No CDN cache headers on
  // public GETs" / `caching-and-cost.md`.
  @Public()
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get('public-handles')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({
    summary:
      'List every crawlable persona handle (public, for sitemap/prerender)',
  })
  @ApiOkResponse({ description: 'All published persona handles.' })
  listPublicHandles() {
    return this.subprofilesService.listPublicHandles();
  }

  // --- invitee-scoped co-owner invites — literal 'invites/...' routes, must
  //     sit above ':id' below (else ':id' would capture 'invites'). ---------

  @Get('invites/mine')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'List co-owner invites sent to the current member' })
  @ApiOkResponse({ description: 'The member’s pending co-owner invites.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listMyInvites(@CurrentUser() user: CurrentUserData) {
    return this.subprofileInvitesService.listMine(user.userId);
  }

  @Post('invites/:inviteId/accept')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Accept a co-owner invite' })
  @ApiCreatedResponse({ description: '`{ ok: true }` once accepted.' })
  @ApiNotFoundResponse({
    description: 'No invite addressed to you with that id.',
  })
  @ApiConflictResponse({ description: 'That invite is no longer pending.' })
  @ApiBadRequestResponse({ description: 'The persona is already full.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async acceptInvite(
    @CurrentUser() user: CurrentUserData,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ): Promise<{ ok: true }> {
    await this.subprofileInvitesService.accept(user.userId, inviteId);
    return { ok: true };
  }

  @Post('invites/:inviteId/decline')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Decline a co-owner invite' })
  @ApiCreatedResponse({ description: '`{ ok: true }` once declined.' })
  @ApiNotFoundResponse({
    description: 'No invite addressed to you with that id.',
  })
  @ApiConflictResponse({ description: 'That invite is no longer pending.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async declineInvite(
    @CurrentUser() user: CurrentUserData,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ): Promise<{ ok: true }> {
    await this.subprofileInvitesService.decline(user.userId, inviteId);
    return { ok: true };
  }

  @Post()
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Create a subprofile' })
  @ApiCreatedResponse({
    description: 'The newly created subprofile (owner-facing view).',
  })
  @ApiBadRequestResponse({
    description: 'Invalid field (e.g. unknown accent, CTA pairing).',
  })
  @ApiConflictResponse({ description: 'Slug or handle already in use.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
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
  getOne(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subprofilesService.getOwnedDTO(user.userId, id);
  }

  @Patch(':id')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Update a subprofile’s core fields' })
  @ApiOkResponse({ description: 'The updated subprofile (owner-facing view).' })
  @ApiBadRequestResponse({
    description: 'Invalid field (e.g. unknown accent, CTA pairing).',
  })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiConflictResponse({ description: 'Slug or handle already in use.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubprofileDTO,
  ) {
    return this.subprofilesService.update(user.userId, id, dto);
  }

  @Put(':id/sections/:section')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Replace all items in one section of a subprofile' })
  @ApiOkResponse({ description: 'The updated subprofile (owner-facing view).' })
  @ApiBadRequestResponse({
    description: 'Unknown section, or invalid items (e.g. multiple featured).',
  })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  replaceSection(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
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
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  replaceSocialLinks(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
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
  @ApiOperation({
    summary: 'Replace a subprofile’s event/community affiliations',
  })
  @ApiOkResponse({ description: 'The updated subprofile (owner-facing view).' })
  @ApiBadRequestResponse({ description: 'Invalid affiliations.' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  replaceAffiliations(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
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
  @ApiCreatedResponse({
    description: 'The published subprofile (owner-facing view).',
  })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnprocessableEntityResponse({
    description:
      'The persona is not ready to publish (unmet requirements or the handle was just taken).',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  publish(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subprofilesService.publish(user.userId, id);
  }

  @Post(':id/unpublish')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Unpublish a subprofile back to draft' })
  @ApiCreatedResponse({
    description: 'The unpublished subprofile (owner-facing view).',
  })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  unpublish(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subprofilesService.unpublish(user.userId, id);
  }

  @Delete(':id')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Delete a subprofile' })
  @ApiOkResponse({ description: '`{ ok: true }` once deleted.' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.subprofilesService.remove(user.userId, id);
    return { ok: true };
  }

  // --- co-owners — sit below every literal route above (':id' captures
  //     anything not already matched), but before the endorsement routes. ---

  @Get(':id/members')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'List the co-owners of a subprofile' })
  @ApiOkResponse({ description: 'The persona co-owners.' })
  @ApiForbiddenResponse({ description: 'You are not a co-owner.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listMembers(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subprofilesService.listMembers(user.userId, id);
  }

  @Delete(':id/members/me')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Leave a subprofile you co-own' })
  @ApiOkResponse({ description: '`{ ok: true }` once you have left.' })
  @ApiForbiddenResponse({ description: 'You are not a co-owner.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiConflictResponse({
    description: 'You are the only owner — delete it instead.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async leave(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.subprofilesService.leave(user.userId, id);
    return { ok: true };
  }

  @Post(':id/invites')
  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Invite a member to co-own a subprofile' })
  @ApiCreatedResponse({ description: 'The newly created pending invite.' })
  @ApiForbiddenResponse({ description: 'You are not a co-owner.' })
  @ApiNotFoundResponse({
    description: 'No subprofile with that id, or no such member.',
  })
  @ApiBadRequestResponse({
    description:
      'You cannot invite yourself/a blocked member, or the persona is at its co-owner cap.',
  })
  @ApiConflictResponse({
    description:
      'They already co-own this persona or already have a pending invite.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  inviteCoOwner(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteCollaboratorDTO,
  ) {
    return this.subprofileInvitesService.invite(user.userId, id, dto.slug);
  }

  @Get(':id/invites')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'List a subprofile’s pending co-owner invites' })
  @ApiOkResponse({ description: 'The pending co-owner invites.' })
  @ApiForbiddenResponse({ description: 'You are not a co-owner.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listInvites(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subprofileInvitesService.listInvites(user.userId, id);
  }

  @Delete(':id/invites/:inviteId')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Revoke a pending co-owner invite' })
  @ApiOkResponse({ description: '`{ ok: true }` once revoked.' })
  @ApiForbiddenResponse({ description: 'You are not a co-owner.' })
  @ApiNotFoundResponse({ description: 'No subprofile or invite with that id.' })
  @ApiConflictResponse({ description: 'That invite is no longer pending.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async revokeInvite(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ): Promise<{ ok: true }> {
    await this.subprofileInvitesService.revoke(user.userId, id, inviteId);
    return { ok: true };
  }

  // --- endorsements — sit below every literal route above; ':id' captures
  //     anything not already matched, so these must stay last. -------------

  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':id/endorse')
  @ApiOperation({ summary: 'Endorse a subprofile (optionally with a note)' })
  @ApiCreatedResponse({ description: 'The updated endorsement standing.' })
  @ApiBadRequestResponse({
    description: 'You cannot endorse your own persona.',
  })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  endorse(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndorseDTO,
  ) {
    return this.subprofilesService.endorse(user.userId, id, dto.note);
  }

  @UseGuards(ActiveMemberGuard)
  @Delete(':id/endorse')
  @ApiOperation({ summary: 'Withdraw your endorsement of a subprofile' })
  @ApiOkResponse({ description: 'The updated endorsement standing.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  withdrawEndorsement(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subprofilesService.withdrawEndorsement(user.userId, id);
  }

  @UseGuards(ActiveMemberGuard)
  @Get(':id/endorsements')
  @ApiOperation({ summary: 'List a subprofile’s endorsers' })
  @ApiOkResponse({ description: 'The endorsers of the subprofile.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listEndorsers(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
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
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  follow(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subprofilesService.follow(user.userId, id);
  }

  @UseGuards(ActiveMemberGuard)
  @Delete(':id/follow')
  @ApiOperation({ summary: 'Unfollow a subprofile' })
  @ApiOkResponse({ description: 'The updated follow standing.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  unfollow(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
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
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listForProfile(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.subprofilesService.listForProfile(slug, user.userId);
  }

  // Single linked+published persona nested under a member's profile, by its
  // per-owner slug — the nested-linked counterpart to `SubprofilesController
  // .getByHandle` (design plan Phase 1b Task 1: a single fetch is what lets
  // this one persona carry its own `restrictedState` signal, which the bulk
  // list above cannot). Same public, best-effort-auth treatment as
  // `by-handle/:handle` — see that route's comment.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':slug/subprofiles/:subslug')
  @ApiOperation({
    summary:
      'Get one linked subprofile nested under a member’s profile (public view)',
  })
  @ApiOkResponse({ description: 'The subprofile’s public view.' })
  @ApiForbiddenResponse({
    description:
      'Restricted — response body is `{ restrictedState: "private" | "members_only" | "removed" }`.',
  })
  @ApiNotFoundResponse({
    description:
      'No such member/persona, or an unpublished draft viewed by a non-owner.',
  })
  getBySlug(
    @CurrentUser() user: CurrentUserData | undefined,
    @Param('slug') slug: string,
    @Param('subslug') subslug: string,
  ) {
    return this.subprofilesService.getBySlugForProfile(slug, subslug, user);
  }
}
