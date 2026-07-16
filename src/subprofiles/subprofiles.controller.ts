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
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CreateSubprofileDTO } from './dto/create-subprofile.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';
import { ReplaceItemsDTO } from './dto/replace-items.dto';
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
