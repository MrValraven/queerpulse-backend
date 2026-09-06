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
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { StaffRolesGuard } from '../auth/guards/staff-roles.guard';
import { Feature } from '../common/feature.decorator';
import { CreateDeckDto } from './dto/create-deck.dto';
import { UpdateDeckDto } from './dto/update-deck.dto';
import { MagazinePieceService } from './magazine-piece.service';
import { MagazineService } from './magazine.service';
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

// ActiveMemberGuard runs first (a suspended moderator is locked out), then
// StaffRolesGuard requires the `magazine_editor` staff role (admins are a
// superset). Route prefix is `magazine/admin/decks`, distinct from the
// public `magazine/decks` GET routes on MagazineController.
@Feature('magazine')
@ApiTags('Admin — Magazine')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Magazine editor staff role or admin role required.',
})
@Controller('magazine/admin/decks')
@UseGuards(ActiveMemberGuard, StaffRolesGuard)
@StaffRoles('magazine_editor')
export class AdminMagazineDecksController {
  constructor(
    private readonly magazine: MagazineService,
    private readonly magazinePieces: MagazinePieceService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List every magazine deck, drafts included.' })
  @ApiOkResponse({ description: 'All decks, newest edit first.' })
  listAll() {
    return this.magazine.listAllDecks();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a magazine deck by id, drafts included.' })
  @ApiOkResponse({ description: 'The deck.' })
  @ApiBadRequestResponse({ description: 'Malformed deck id.' })
  @ApiNotFoundResponse({ description: 'No deck exists for this id.' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.magazine.getDeckById(id);
  }

  // PRD-131 — backs the editor's "With issue" publish timing. Declared after
  // `GET :id` for readability only: the two paths differ in segment count,
  // so neither can shadow the other.
  @Get(':id/issue-link')
  @ApiOperation({
    summary:
      'The desk piece and issue this deck is filed under, for the editor’s "With issue" publish timing.',
  })
  @ApiOkResponse({
    description:
      'The linked piece id, issue number and issue title, each null when that link does not exist yet.',
  })
  @ApiBadRequestResponse({ description: 'Malformed deck id.' })
  @ApiNotFoundResponse({ description: 'No deck exists for this id.' })
  getIssueLink(@Param('id', ParseUUIDPipe) id: string) {
    return this.magazine.getDeckIssueLink(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a draft magazine deck.' })
  @ApiCreatedResponse({ description: 'The created draft deck.' })
  @ApiBadRequestResponse({ description: 'The deck payload is invalid.' })
  @ApiConflictResponse({ description: 'A deck with this slug already exists.' })
  create(@Body() dto: CreateDeckDto, @CurrentUser() user: CurrentUserData) {
    return this.magazine.createDeck(dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update a magazine deck, including publish state (publish now, schedule, or unpublish).',
  })
  @ApiOkResponse({ description: 'The updated deck.' })
  @ApiBadRequestResponse({
    description:
      'Malformed id, invalid payload, or a publish/schedule of a deck that fails the readiness bar (at least one slide, alt text on every image slide).',
  })
  @ApiNotFoundResponse({ description: 'No deck exists for this id.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeckDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazine.updateDeck(id, dto, user.userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an unpublished, unlinked magazine deck (ENG-112).',
  })
  @ApiNoContentResponse({ description: 'The deck was deleted.' })
  @ApiBadRequestResponse({ description: 'Malformed deck id.' })
  @ApiConflictResponse({
    description:
      'The deck is published (unpublish it first), or a desk piece still links to it (delete the piece instead).',
  })
  @ApiNotFoundResponse({ description: 'No deck exists for this id.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.magazine.deleteDeck(id);
  }

  @Post(':id/convert-to-article')
  @ApiOperation({
    summary:
      'Convert this deck to an article (one-way, one-time — CNT-6 "Convert").',
  })
  @ApiOkResponse({
    description:
      'The piece and newly created article ids, plus which slides (if any) had no article-block equivalent and were dropped.',
  })
  @ApiBadRequestResponse({ description: 'Malformed deck id.' })
  @ApiConflictResponse({
    description: 'This piece has already been converted to an article.',
  })
  @ApiNotFoundResponse({
    description: 'No deck exists for this id, or no piece links to it.',
  })
  convertToArticle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.convertDeckToArticle(id, user.userId);
  }
}
