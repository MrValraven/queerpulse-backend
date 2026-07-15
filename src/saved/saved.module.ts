import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavedItem } from './entities/saved-item.entity';
import { SavedController } from './saved.controller';
import { SavedService } from './saved.service';

@Module({
  imports: [TypeOrmModule.forFeature([SavedItem])],
  controllers: [SavedController],
  providers: [SavedService],
  exports: [SavedService],
})
export class SavedModule {}
