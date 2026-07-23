import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrgTier } from './entities/org-tier.entity';
import {
  AdminOrgTiersController,
  OrgTiersController,
} from './org-tiers.controller';
import { OrgTiersService } from './org-tiers.service';

@Module({
  imports: [TypeOrmModule.forFeature([OrgTier])],
  controllers: [OrgTiersController, AdminOrgTiersController],
  providers: [OrgTiersService],
})
export class OrgTiersModule {}
