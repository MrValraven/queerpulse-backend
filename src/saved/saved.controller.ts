import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { ListSavedQuery } from './dto/list-saved.query';
import { SavedItemBodyDto } from './dto/saved-item-body.dto';
import { SavedService } from './saved.service';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// Always-on member primitive (no @Feature flag) — mirrors the FE's saved.api.ts
// exactly: `GET /me/saved`, `PUT /me/saved/:id`, `DELETE /me/saved/:id`.
//
// NOTE: `:id` here is deliberately NOT a `ParseUUIDPipe` param. It is the
// frontend's composite `<kind>:<subjectId>` ref (see `parseSavedRef`), where
// `subjectId` may be a slug, not a uuid — a UUID pipe would 400 valid requests.
// `parseSavedRef` already 400s on a malformed ref, so a bad id never reaches
// TypeORM as a raw uuid cast.
@ApiTags('Saved')
@ApiCookieAuth('access_token')
@Controller('me/saved')
@UseGuards(ActiveMemberGuard)
export class SavedController {
  constructor(private readonly savedService: SavedService) {}

  @ApiOperation({ summary: "List the member's saved items." })
  @ApiOkResponse({ description: 'The saved items, filtered by the query.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Get()
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListSavedQuery) {
    return this.savedService.list(user.userId, query);
  }

  // Upsert; 204 (the frontend's `putSaved` types the response `void`).
  @ApiOperation({ summary: 'Save (upsert) an item by id.' })
  @ApiNoContentResponse({ description: 'The item was saved.' })
  @ApiBadRequestResponse({
    description: 'The id kind does not match `body.kind`.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Put(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  put(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() body: SavedItemBodyDto,
  ) {
    return this.savedService.put(user.userId, id, body);
  }

  @ApiOperation({ summary: 'Remove a saved item by id.' })
  @ApiNoContentResponse({ description: 'The item is no longer saved.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.savedService.remove(user.userId, id);
  }
}
