import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { AmbassadorStatusService } from './ambassador-status.service';
import { Ambassador } from './entities/ambassador.entity';

/**
 * The cheap reads about ambassador status, in a leaf module with no imports
 * beyond TypeORM. `MembershipModule` needs the invite bonus, and `AuthModule`
 * imports `MembershipModule`, so reaching for the full `AmbassadorsModule`
 * (communities, notifications) from there would risk a cycle. Same reason
 * `RecognitionEntitlementsModule` exists.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Ambassador, Profile])],
  providers: [AmbassadorStatusService],
  exports: [AmbassadorStatusService],
})
export class AmbassadorStatusModule {}
