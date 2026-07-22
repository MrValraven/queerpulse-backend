import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminChangemakersController } from './admin-changemakers.controller';
import { ChangemakersController } from './changemakers.controller';
import { ChangemakersService } from './changemakers.service';
import { Changemaker } from './entities/changemaker.entity';
import { ChangemakerDirectorySettings } from './entities/changemaker-directory-settings.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Changemaker, ChangemakerDirectorySettings]),
  ],
  controllers: [ChangemakersController, AdminChangemakersController],
  providers: [ChangemakersService],
})
export class ChangemakersModule {}
