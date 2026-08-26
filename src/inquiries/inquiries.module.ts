import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';
import { Inquiry } from './entities/inquiry.entity';

/**
 * Public marketing-form intake (Contact + For-Organisations partnership).
 * A submission is stored and nothing is dispatched: QueerPulse delivers no
 * email, so the admin triage list is the only place an inquiry surfaces.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Inquiry,
      // Read-only, so the admin triage list can resolve a handler's uuid to a
      // display name through the shared `MemberLookup` without pulling
      // `ProfilesService` (and its module graph) into this small module.
      Profile,
    ]),
  ],
  controllers: [InquiriesController],
  providers: [InquiriesService],
})
export class InquiriesModule {}
