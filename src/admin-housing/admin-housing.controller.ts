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
import { UserRole } from '../users/entities/user.entity';
import { HousingService } from '../housing/housing.service';
import { CreateCoopDto } from '../housing/dto/create-coop.dto';
import { UpdateCoopDto } from '../housing/dto/update-coop.dto';
import { TriageJoinRequestDto } from '../housing/dto/triage-join-request.dto';

@UseGuards(RolesGuard)
@Roles(UserRole.Admin)
@Controller('admin/housing')
export class AdminHousingController {
  constructor(private readonly housing: HousingService) {}

  @Get('coops')
  listCoops() {
    return this.housing.listAllForAdmin();
  }

  @Post('coops')
  createCoop(@Body() dto: CreateCoopDto) {
    return this.housing.createCoop(dto);
  }

  @Patch('coops/:id')
  updateCoop(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCoopDto,
  ) {
    return this.housing.updateCoop(id, dto);
  }

  @Delete('coops/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCoop(@Param('id', ParseUUIDPipe) id: string) {
    return this.housing.deleteCoop(id);
  }

  @Get('join-requests')
  listJoinRequests(@Query('coop') coopSlug?: string) {
    return this.housing.listJoinRequests(coopSlug);
  }

  @Patch('join-requests/:id')
  triageJoinRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageJoinRequestDto,
  ) {
    return this.housing.triageJoinRequest(id, dto.action);
  }
}
