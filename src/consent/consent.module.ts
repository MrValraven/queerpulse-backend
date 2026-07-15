import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { ConsentRecord } from './entities/consent-record.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ConsentRecord])],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
