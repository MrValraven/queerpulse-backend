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
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CreateLandlordDto } from './dto/create-landlord.dto';
import { ListIntroRequestsQuery } from './dto/list-intro-requests.query';
import { TriageIntroRequestDto } from './dto/triage-intro-request.dto';
import { UpdateLandlordStatusDto } from './dto/update-landlord-status.dto';
import { UpdateLandlordDto } from './dto/update-landlord.dto';
import { LandlordsService } from './landlords.service';

/** Moderator/admin moderation of the landlord directory. */
@Feature('landlords')
@Controller('admin/landlords')
@UseGuards(RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminLandlordsController {
  constructor(private readonly service: LandlordsService) {}

  @Get()
  listAll() {
    return this.service.listAllForAdmin();
  }

  @Post()
  create(@Body() dto: CreateLandlordDto) {
    return this.service.adminCreate(dto);
  }

  // Literal `intro-requests` routes declared before `:id` so they win the match.
  @Get('intro-requests')
  listIntroRequests(@Query() query: ListIntroRequestsQuery) {
    return this.service.listIntroRequests(query.landlord);
  }

  @Patch('intro-requests/:id')
  triageIntroRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageIntroRequestDto,
  ) {
    return this.service.triageIntroRequest(id, dto.action);
  }

  // Literal `recommendations` route declared before `:id`.
  @Delete('recommendations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeRecommendation(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.removeRecommendation(id);
  }

  @Patch(':id/status')
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLandlordStatusDto,
  ) {
    return this.service.setStatus(id, dto.status);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLandlordDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
