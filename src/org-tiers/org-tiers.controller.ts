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
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreateOrgTierDto } from './dto/create-org-tier.dto';
import { UpdateOrgTierDto } from './dto/update-org-tier.dto';
import { OrgTiersService } from './org-tiers.service';

// Public marketing content — the For Organisations page is reachable logged-out,
// so the tier list opts out of auth (mirrors PlatformStatusController /
// HealthController's class-level @Public()).
@Public()
@Controller('org-tiers')
export class OrgTiersController {
  constructor(private readonly orgTiersService: OrgTiersService) {}

  @Get()
  list() {
    return this.orgTiersService.listPublished();
  }
}

@Controller('admin/org-tiers')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
export class AdminOrgTiersController {
  constructor(private readonly orgTiersService: OrgTiersService) {}

  @Get()
  list() {
    return this.orgTiersService.listAll();
  }

  @Post()
  create(@Body() dto: CreateOrgTierDto) {
    return this.orgTiersService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrgTierDto,
  ) {
    return this.orgTiersService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.orgTiersService.remove(id);
  }
}
