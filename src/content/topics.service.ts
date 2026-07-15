import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Topic } from './entities/topic.entity';
import { TopicResponse, toTopicResponse } from './topic-response';

@Injectable()
export class TopicsService {
  constructor(
    @InjectRepository(Topic)
    private readonly topics: Repository<Topic>,
  ) {}

  /** The full topic directory, most-posted first. */
  async list(): Promise<TopicResponse[]> {
    const rows = await this.topics.find({ order: { totalPosts: 'DESC' } });
    return rows.map(toTopicResponse);
  }
}
