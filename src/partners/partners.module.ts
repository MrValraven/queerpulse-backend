import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { Partner } from './entities/partner.entity';
import {
  PartnerApplicationsController,
  PartnersController,
} from './partners.controller';
import { PartnersService } from './partners.service';

@Module({
  imports: [TypeOrmModule.forFeature([Partner, Profile]), UsersModule],
  controllers: [PartnersController, PartnerApplicationsController],
  providers: [PartnersService],
  // `VolunteeringModule` imports this module to resolve `partnerSlug` ->
  // `partner_id` and `partner_id` -> `{slug,name}` refs (one-way; `Partners`
  // has no dependency back on `Volunteering`, so no `forwardRef()` needed).
  exports: [PartnersService],
})
export class PartnersModule {}
