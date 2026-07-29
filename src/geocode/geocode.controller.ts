import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { ResolveLinkDto } from './dto/resolve-link.dto';
import { GeocodeService } from './geocode.service';

@Controller('geocode')
@UseGuards(ActiveMemberGuard)
export class GeocodeController {
  constructor(private readonly geocodeService: GeocodeService) {}

  @Post('resolve-link')
  @HttpCode(200)
  resolveLink(@Body() dto: ResolveLinkDto) {
    return this.geocodeService.resolveLink(dto.url);
  }
}
