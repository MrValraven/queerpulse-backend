import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { StaffRolesGuard } from '../auth/guards/staff-roles.guard';
import { Feature } from '../common/feature.decorator';
import { CreateArticleCommentDto } from './dto/create-article-comment.dto';
import { CreateArticleVersionDto } from './dto/create-article-version.dto';
import { CreateCorrectionDto } from './dto/create-correction.dto';
import { CreateLetterDto } from './dto/create-letter.dto';
import { CreatePieceDto } from './dto/create-piece.dto';
import { CreatePieceMessageDto } from './dto/create-piece-message.dto';
import { CreatePitchDto } from './dto/create-pitch.dto';
import { ListPiecesQuery } from './dto/list-pieces.query';
import { ReplyArticleCommentDto } from './dto/reply-article-comment.dto';
import { ResolveArticleCommentDto } from './dto/resolve-article-comment.dto';
import { TriagePitchDto } from './dto/triage-pitch.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { UpdateLetterDto } from './dto/update-letter.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { UpdatePieceDto } from './dto/update-piece.dto';
import { MagazinePieceService } from './magazine-piece.service';

// ActiveMemberGuard runs first (a suspended moderator is locked out), then
// StaffRolesGuard requires the `magazine_editor` staff role (admins are a
// superset). Route prefixes are `magazine/admin/pieces`,
// `magazine/admin/pitches`, and `magazine/admin/desk-summary` — distinct
// from `magazine/admin/decks` on AdminMagazineDecksController and the
// public `magazine/*` GET routes on MagazineController.
@Feature('magazine')
@ApiTags('Admin — Magazine')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Magazine editor staff role or admin role required.',
})
@Controller('magazine/admin')
@UseGuards(ActiveMemberGuard, StaffRolesGuard)
@StaffRoles('magazine_editor')
export class AdminMagazinePiecesController {
  constructor(private readonly magazinePieces: MagazinePieceService) {}

  @Get('pieces')
  @ApiOperation({ summary: 'List magazine pieces on the desk, with filters.' })
  @ApiOkResponse({ description: 'Matching pieces, newest first.' })
  listPieces(@Query() query: ListPiecesQuery) {
    return this.magazinePieces.listPieces(query);
  }

  @Get('pieces/:id')
  @ApiOperation({ summary: 'Get a magazine piece record by id.' })
  @ApiOkResponse({
    description:
      'The piece record, with its audit history, payment, letters, corrections, and publish gate.',
  })
  @ApiBadRequestResponse({ description: 'Malformed piece id.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  getPieceById(@Param('id', ParseUUIDPipe) id: string) {
    return this.magazinePieces.getPieceRecordFull(id);
  }

  @Post('pieces')
  @ApiOperation({ summary: 'Commission a new magazine piece.' })
  @ApiCreatedResponse({ description: 'The created piece.' })
  @ApiBadRequestResponse({ description: 'The piece payload is invalid.' })
  createPiece(
    @Body() dto: CreatePieceDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.createPiece(dto, user.userId);
  }

  @Patch('pieces/:id')
  @ApiOperation({ summary: 'Update a magazine piece, including its stage.' })
  @ApiOkResponse({ description: 'The updated piece.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  updatePiece(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePieceDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.updatePiece(id, dto, user.userId);
  }

  @Delete('pieces/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a magazine piece.' })
  @ApiNoContentResponse({ description: 'The piece was deleted.' })
  @ApiBadRequestResponse({ description: 'Malformed piece id.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  deletePiece(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.deletePiece(id, user.userId);
  }

  @Patch('pieces/:id/payment')
  @ApiOperation({
    summary: 'Create or update the payment record for a magazine piece.',
  })
  @ApiOkResponse({ description: 'The upserted payment record.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  upsertPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.upsertPayment(id, dto, user.userId);
  }

  @Get('pieces/:id/letters')
  @ApiOperation({ summary: 'List reader letters for a magazine piece.' })
  @ApiOkResponse({ description: 'The letters, newest first.' })
  @ApiBadRequestResponse({ description: 'Malformed piece id.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  listLetters(@Param('id', ParseUUIDPipe) id: string) {
    return this.magazinePieces.listLetters(id);
  }

  @Post('pieces/:id/letters')
  @ApiOperation({ summary: 'Add a reader letter to a magazine piece.' })
  @ApiCreatedResponse({ description: 'The created letter.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  addLetter(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateLetterDto,
  ) {
    return this.magazinePieces.addLetter(id, dto);
  }

  @Patch('pieces/:id/letters/:letterId')
  @ApiOperation({
    summary: 'Toggle whether a reader letter runs in the letters column.',
  })
  @ApiOkResponse({ description: 'The updated letter.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({
    description: 'No piece exists for this id, or no letter for this id.',
  })
  updateLetter(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
    @Body() dto: UpdateLetterDto,
  ) {
    return this.magazinePieces.updateLetter(id, letterId, dto.runInLetters);
  }

  @Post('pieces/:id/corrections')
  @ApiOperation({ summary: 'Publish a correction for a magazine piece.' })
  @ApiCreatedResponse({ description: 'The created correction.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  addCorrection(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCorrectionDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.addCorrection(id, dto, user.userId);
  }

  @Get('pieces/:id/article')
  @ApiOperation({
    summary: 'Get the article draft linked to a magazine piece.',
  })
  @ApiOkResponse({
    description:
      'The article draft (title, standfirst, kicker, section, tags, content notes, blocks, read time).',
  })
  @ApiBadRequestResponse({ description: 'Malformed piece id.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  getArticleDraft(@Param('id', ParseUUIDPipe) id: string) {
    return this.magazinePieces.getArticleDraft(id);
  }

  @Patch('pieces/:id/article')
  @ApiOperation({ summary: 'Update the article draft for a magazine piece.' })
  @ApiOkResponse({ description: 'The updated article draft.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  updateArticleDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateArticleDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.updateArticleDraft(id, dto, user.userId);
  }

  @Get('pieces/:id/comments')
  @ApiOperation({
    summary:
      "List the threaded comment tree for a piece's article (NotesRail).",
  })
  @ApiOkResponse({
    description:
      'Top-level comments (newest first) with nested replies (oldest first), author names resolved.',
  })
  @ApiBadRequestResponse({ description: 'Malformed piece id.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  listArticleComments(@Param('id', ParseUUIDPipe) id: string) {
    return this.magazinePieces.listArticleComments(id);
  }

  @Post('pieces/:id/comments')
  @ApiOperation({
    summary: "Add a top-level note to a piece's article (NotesRail).",
  })
  @ApiCreatedResponse({ description: 'The created comment.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  addArticleComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateArticleCommentDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.addArticleComment(id, user.userId, dto);
  }

  @Post('comments/:commentId/reply')
  @ApiOperation({ summary: 'Reply to an article comment (NotesRail thread).' })
  @ApiCreatedResponse({ description: 'The created reply.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No comment exists for this id.' })
  replyToArticleComment(
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: ReplyArticleCommentDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.replyToArticleComment(
      commentId,
      user.userId,
      dto,
    );
  }

  @Patch('comments/:commentId/resolve')
  @ApiOperation({ summary: 'Resolve or reopen an article comment.' })
  @ApiOkResponse({ description: 'The updated comment.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No comment exists for this id.' })
  resolveArticleComment(
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: ResolveArticleCommentDto,
  ) {
    return this.magazinePieces.resolveArticleComment(commentId, dto);
  }

  @Get('pieces/:id/versions')
  @ApiOperation({
    summary:
      "List a piece's article version history (VersionsRail), newest first.",
  })
  @ApiOkResponse({
    description:
      'Version summaries (id, label, author, createdAt) — no blocks payload.',
  })
  @ApiBadRequestResponse({ description: 'Malformed piece id.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  listArticleVersions(@Param('id', ParseUUIDPipe) id: string) {
    return this.magazinePieces.listArticleVersions(id);
  }

  @Post('pieces/:id/versions')
  @ApiOperation({
    summary: "Snapshot the piece's article now (VersionsRail manual save).",
  })
  @ApiCreatedResponse({ description: 'The created version summary.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  createArticleVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateArticleVersionDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.createArticleVersion(id, user.userId, dto.label);
  }

  @Post('pieces/:id/versions/:versionId/restore')
  @ApiOperation({
    summary:
      "Restore a version's blocks onto the piece's article (VersionsRail Restore).",
  })
  @ApiOkResponse({
    description:
      'The updated article draft. The pre-restore state and the restore itself are both recorded as new versions, so nothing is lost.',
  })
  @ApiBadRequestResponse({ description: 'Malformed id.' })
  @ApiNotFoundResponse({
    description:
      'No piece exists for this id, the piece has no article yet, or the version belongs to a different piece.',
  })
  restoreArticleVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.restoreArticleVersion(
      id,
      versionId,
      user.userId,
    );
  }

  @Get('versions/:versionId')
  @ApiOperation({
    summary: "Get one article version's full detail (VersionsRail diff view).",
  })
  @ApiOkResponse({
    description: 'The version, including its full blocks snapshot.',
  })
  @ApiBadRequestResponse({ description: 'Malformed version id.' })
  @ApiNotFoundResponse({ description: 'No version exists for this id.' })
  getArticleVersion(@Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.magazinePieces.getArticleVersion(versionId);
  }

  @Get('pieces/:id/messages')
  @ApiOperation({
    summary:
      'List the editor↔writer message thread for a piece (editor surface).',
  })
  @ApiOkResponse({
    description:
      'The thread, oldest first, author names resolved. Forbidden unless the caller is the assigned editor/admin.',
  })
  @ApiBadRequestResponse({ description: 'Malformed piece id.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  listPieceMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.listPieceMessages(id, user.userId, true);
  }

  @Post('pieces/:id/messages')
  @ApiOperation({
    summary: "Post to a piece's editor↔writer message thread (editor surface).",
  })
  @ApiCreatedResponse({ description: 'The created message.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  postPieceMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePieceMessageDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.postPieceMessage(id, user.userId, true, dto);
  }

  @Get('pitches')
  @ApiOperation({
    summary: 'List pitches awaiting triage in the editor inbox.',
  })
  @ApiOkResponse({ description: 'Waiting and maybe pitches, newest first.' })
  listPitches() {
    return this.magazinePieces.listPitches();
  }

  @Post('pitches')
  @ApiOperation({ summary: 'Submit a new pitch to the editor inbox.' })
  @ApiCreatedResponse({ description: 'The created pitch.' })
  @ApiBadRequestResponse({ description: 'The pitch payload is invalid.' })
  createPitch(@Body() dto: CreatePitchDto) {
    return this.magazinePieces.createPitch(dto);
  }

  @Patch('pitches/:id')
  @ApiOperation({
    summary: 'Triage a pitch: mark maybe, pass, or commission it.',
  })
  @ApiOkResponse({
    description:
      'The updated pitch, or the newly commissioned piece if the verdict was `commission`.',
  })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No pitch exists for this id.' })
  @ApiConflictResponse({ description: 'This pitch has already been triaged.' })
  triagePitch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriagePitchDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.triagePitch(id, dto, user.userId);
  }

  @Get('desk-summary')
  @ApiOperation({ summary: 'Get the magazine desk summary roll-up.' })
  @ApiOkResponse({
    description: 'Editor load, waiting-on counts, and recent activity.',
  })
  deskSummary() {
    return this.magazinePieces.deskSummary();
  }

  @Get('editors')
  @ApiOperation({
    summary:
      'List the magazine editor directory: magazine_editor staff-role holders plus admins.',
  })
  @ApiOkResponse({
    description: 'Editors, hand-mapped with no user-account leak.',
  })
  listMagazineEditors() {
    return this.magazinePieces.listMagazineEditors();
  }

  @Get('notifications')
  @ApiOperation({
    summary:
      'List recent magazine desk notifications (the "Since Friday" panel).',
  })
  @ApiOkResponse({
    description:
      "Recent piece-event activity, hand-mapped to who/what/when/route/tone/isUnread (against the caller's own read cursor), newest first.",
  })
  listMagazineNotifications(@CurrentUser() user: CurrentUserData) {
    return this.magazinePieces.listMagazineNotifications(user.userId);
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Mark every current desk notification read for the caller (advances their read cursor to now).',
  })
  @ApiNoContentResponse({ description: 'The read cursor was advanced.' })
  markNotificationsRead(@CurrentUser() user: CurrentUserData) {
    return this.magazinePieces.markNotificationsRead(user.userId);
  }

  @Get('archive')
  @ApiOperation({
    summary:
      'Search the published archive (articles + decks) for the ArchiveTab.',
  })
  @ApiOkResponse({
    description:
      'Matching published items (title, issue, byline, tags), newest first; recent published items when `q` is omitted.',
  })
  searchArchive(@Query('q') q?: string) {
    return this.magazinePieces.searchArchive(q ?? '');
  }
}
