import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { ChangemakersService } from './changemakers.service';
import { CreateChangemakerDto } from './dto/create-changemaker.dto';
import { PublishChangemakerDto } from './dto/publish-changemaker.dto';
import { UpdateChangemakerDto } from './dto/update-changemaker.dto';
import { UpdateDirectoryStatsDto } from './dto/update-directory-stats.dto';

@UseGuards(RolesGuard)
@Roles(UserRole.Admin)
@Controller('admin/changemakers')
export class AdminChangemakersController {
  constructor(private readonly changemakers: ChangemakersService) {}

  @Get()
  list() {
    return this.changemakers.listAdmin();
  }

  // Declared before ':id' so 'stats' is not captured as an id param.
  @Patch('stats')
  updateStats(@Body() dto: UpdateDirectoryStatsDto) {
    return this.changemakers.updateStats(dto);
  }

  @Post()
  create(@Body() dto: CreateChangemakerDto) {
    return this.changemakers.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateChangemakerDto) {
    return this.changemakers.update(id, dto);
  }

  @Patch(':id/publish')
  publish(@Param('id') id: string, @Body() body: PublishChangemakerDto) {
    return this.changemakers.setPublished(id, body.published);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.changemakers.remove(id);
  }
}
