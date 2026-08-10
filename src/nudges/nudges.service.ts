import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PersonaNudge } from './entities/persona-nudge.entity';
import { MyNudgesResponse } from './nudges-response';
import { NUDGE_CAP, NUDGE_KEYS, isNudgeKey } from './nudges.constants';

@Injectable()
export class NudgesService {
  constructor(
    @InjectRepository(PersonaNudge)
    private readonly nudges: Repository<PersonaNudge>,
  ) {}

  // The caller's dismissed nudge keys + whether the 2-dismissal cap is hit.
  async myNudges(userId: string): Promise<MyNudgesResponse> {
    const rows = await this.nudges.find({
      where: { userId },
      select: { nudgeKey: true },
    });
    return this.toResponse(rows.map((row) => row.nudgeKey));
  }

  /**
   * Dismiss a nudge moment for good. Idempotent: a repeat dismiss of the same
   * key is absorbed by `ON CONFLICT DO NOTHING` against the unique
   * `(user_id, nudge_key)` index, so a double-tap (or two devices racing)
   * never 500s and never inserts a second row or double-counts toward the
   * cap. `key` is validated against the fixed `NUDGE_KEYS` set — an unknown
   * key 400s rather than being trusted from the client.
   */
  async dismiss(userId: string, key: string): Promise<MyNudgesResponse> {
    if (!isNudgeKey(key)) {
      throw new BadRequestException(
        `Unknown nudge key. Expected one of: ${NUDGE_KEYS.join(', ')}`,
      );
    }

    await this.nudges
      .createQueryBuilder()
      .insert()
      .into(PersonaNudge)
      .values({ userId, nudgeKey: key })
      .orIgnore()
      .execute();

    return this.myNudges(userId);
  }

  private toResponse(dismissedKeys: string[]): MyNudgesResponse {
    return { dismissedKeys, capped: dismissedKeys.length >= NUDGE_CAP };
  }
}
