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
  Put,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { SavedItemBodyDto } from './dto/saved-item-body.dto';
import { SavedListBodyDto } from './dto/saved-list-body.dto';
import { SavedListsService } from './saved-lists.service';

/**
 * Named saved lists, for their owner.
 *
 * Its own controller under `me/saved/lists` rather than more routes on
 * `SavedController`, because that class's `:id` is the composite
 * `<kind>:<subjectId>` ref and this one's is a real uuid. Mixing the two on one
 * class would put two incompatible param conventions behind the same name and
 * make the `ParseUUIDPipe`s below impossible. It is registered BEFORE
 * `SavedController` in `SavedModule` so the literal `lists` segment always wins
 * over that controller's `:id` param, rather than depending on nobody ever
 * adding a route shaped like it.
 *
 * The `:listId` params carry `ParseUUIDPipe` on purpose: a list id IS a uuid
 * here, so a malformed one is a 400 rather than a Postgres "invalid input
 * syntax for type uuid" error surfacing as a 500.
 */
@ApiTags('Saved')
@ApiCookieAuth('access_token')
@Controller('me/saved/lists')
@UseGuards(ActiveMemberGuard)
export class SavedListsController {
  constructor(private readonly savedListsService: SavedListsService) {}

  @ApiOperation({ summary: "List the member's saved lists." })
  @ApiOkResponse({
    description: 'The lists, the default one first, each with an item count.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Get()
  list(@CurrentUser() user: CurrentUserData) {
    return this.savedListsService.listLists(user.userId);
  }

  @ApiOperation({ summary: 'Create a named list.' })
  @ApiCreatedResponse({ description: 'The new, empty list.' })
  @ApiConflictResponse({
    description: 'A list with that name exists, or the list cap is reached.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() body: SavedListBodyDto) {
    return this.savedListsService.createList(user.userId, body);
  }

  @ApiOperation({ summary: 'Rename a list.' })
  @ApiOkResponse({ description: 'The renamed list.' })
  @ApiConflictResponse({ description: 'A list with that name exists.' })
  @ApiNotFoundResponse({ description: 'No such list for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Patch(':listId')
  rename(
    @CurrentUser() user: CurrentUserData,
    @Param('listId', ParseUUIDPipe) listId: string,
    @Body() body: SavedListBodyDto,
  ) {
    return this.savedListsService.renameList(user.userId, listId, body);
  }

  @ApiOperation({
    summary: 'Delete a list. The items in it stay saved.',
  })
  @ApiNoContentResponse({ description: 'The list is gone; the items are not.' })
  @ApiBadRequestResponse({
    description: 'The default list cannot be deleted.',
  })
  @ApiNotFoundResponse({ description: 'No such list for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Delete(':listId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('listId', ParseUUIDPipe) listId: string,
  ) {
    return this.savedListsService.deleteList(user.userId, listId);
  }

  // Save the item and file it in this list in one call. `:id` is the composite
  // `<kind>:<subjectId>` ref, NOT a uuid, so it deliberately carries no
  // `ParseUUIDPipe` (see `SavedController`'s note on the same param).
  @ApiOperation({ summary: 'Save an item and add it to this list.' })
  @ApiNoContentResponse({ description: 'The item is saved and in the list.' })
  @ApiBadRequestResponse({
    description: 'The id kind does not match `body.kind`.',
  })
  @ApiNotFoundResponse({ description: 'No such list for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Put(':listId/items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  addItem(
    @CurrentUser() user: CurrentUserData,
    @Param('listId', ParseUUIDPipe) listId: string,
    @Param('id') id: string,
    @Body() body: SavedItemBodyDto,
  ) {
    return this.savedListsService.addItemToList(user.userId, listId, id, body);
  }

  @ApiOperation({
    summary: 'Take an item out of this list without unsaving it.',
  })
  @ApiNoContentResponse({ description: 'The item is no longer in this list.' })
  @ApiBadRequestResponse({
    description: 'Items leave the default list by being unsaved.',
  })
  @ApiNotFoundResponse({ description: 'No such list for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Delete(':listId/items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeItem(
    @CurrentUser() user: CurrentUserData,
    @Param('listId', ParseUUIDPipe) listId: string,
    @Param('id') id: string,
  ) {
    return this.savedListsService.removeItemFromList(user.userId, listId, id);
  }

  // Sharing is off until this is called, and one call away from off again.
  @ApiOperation({
    summary: 'Turn on a share link for this list (off by default).',
  })
  @ApiOkResponse({
    description: 'The list with its share token. Idempotent.',
  })
  @ApiNotFoundResponse({ description: 'No such list for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Post(':listId/share')
  @HttpCode(HttpStatus.OK)
  share(
    @CurrentUser() user: CurrentUserData,
    @Param('listId', ParseUUIDPipe) listId: string,
  ) {
    return this.savedListsService.share(user.userId, listId);
  }

  @ApiOperation({
    summary: 'Revoke this list’s share link. Every copy of it stops working.',
  })
  @ApiOkResponse({ description: 'The list, now private. Idempotent.' })
  @ApiNotFoundResponse({ description: 'No such list for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Delete(':listId/share')
  @HttpCode(HttpStatus.OK)
  unshare(
    @CurrentUser() user: CurrentUserData,
    @Param('listId', ParseUUIDPipe) listId: string,
  ) {
    return this.savedListsService.unshare(user.userId, listId);
  }
}
