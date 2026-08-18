import { Module } from '@nestjs/common';
import { ForumModule } from '../forum/forum.module';
import { AdminForumController } from './admin-forum.controller';
import { AdminForumService } from './admin-forum.service';

@Module({
  // Exports `ForumThreadsService`, which owns the thread read/write logic
  // this module delegates to.
  imports: [ForumModule],
  controllers: [AdminForumController],
  providers: [AdminForumService],
})
export class AdminForumModule {}
