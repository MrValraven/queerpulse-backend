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

// Always-on member primitive (no @Feature flag) — mirrors the FE's saved.api.ts
// exactly: `GET /me/saved`, `PUT /me/saved/:id`, `DELETE /me/saved/:id`.
@Controller('me/saved')
@UseGuards(ActiveMemberGuard)
export class SavedController {
  constructor(private readonly savedService: SavedService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListSavedQuery) {
    return this.savedService.list(user.userId, query);
  }

  // Upsert; 204 (the frontend's `putSaved` types the response `void`).
  @Put(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  put(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() body: SavedItemBodyDto,
  ) {
    return this.savedService.put(user.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.savedService.remove(user.userId, id);
  }
}
