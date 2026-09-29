import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommunitiesService } from '../communities/communities.service';
import { Community } from '../communities/entities/community.entity';
import { CardProgramsService } from '../membership-cards/card-programs.service';
import { OfficialConversationsService } from '../official-messages/official-conversations.service';
import {
  CIRCLE_CARD_PROGRAM,
  CIRCLE_COMMUNITY_INPUT,
} from './ambassador-circle.data';
import { AmbassadorCircle } from './entities/ambassador-circle.entity';

/** Advisory-lock key for creating the circle. Distinct from MIGRATION_LOCK_KEY. */
const CIRCLE_CREATE_LOCK_SQL = `SELECT pg_advisory_lock(hashtext('queerpulse:ambassador-circle'))`;
const CIRCLE_CREATE_UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtext('queerpulse:ambassador-circle'))`;

/** The one row of `ambassador_circle` (a CHECK pins its id to 1). */
const CIRCLE_PIN_ID = 1;

@Injectable()
export class AmbassadorCircleService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(AmbassadorCircle)
    private readonly circlePin: Repository<AmbassadorCircle>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly communitiesService: CommunitiesService,
    private readonly cardPrograms: CardProgramsService,
    private readonly officialConversations: OfficialConversationsService,
  ) {}

  /**
   * The circle community, created on first use. The house account is created
   * lazily too (see `resolveOfficialSenderId`), so a migration could not seed
   * a community it owns. A session-level advisory lock keeps two first grants
   * from founding two circles; `CommunitiesService.create` opens its own
   * transactions on other connections, which a transaction-level lock would
   * not cover.
   *
   * The pin is written straight after the community, before the card
   * programme: should the programme write fail, the next call finds the
   * pinned circle and founds no second one. Staff can then switch the card on
   * from the circle's mod tools after taking a staff seat.
   */
  async resolveCircle(): Promise<Community> {
    const pinned = await this.findPinned();
    if (pinned) return pinned;
    const lockRunner = this.dataSource.createQueryRunner();
    await lockRunner.connect();
    try {
      await lockRunner.query(CIRCLE_CREATE_LOCK_SQL);
      const pinnedWhileWaiting = await this.findPinned();
      if (pinnedWhileWaiting) return pinnedWhileWaiting;
      const houseAccountId =
        await this.officialConversations.resolveOfficialSenderId();
      const created = await this.communitiesService.create(
        houseAccountId,
        CIRCLE_COMMUNITY_INPUT,
      );
      // The detail DTO carries no id. The slug is unique, and this is the
      // row `create` just allocated it to.
      const community = await this.communities.findOneOrFail({
        where: { slug: created.slug },
      });
      await this.circlePin.insert({
        id: CIRCLE_PIN_ID,
        communityId: community.id,
      });
      await this.cardPrograms.upsert(
        community.slug,
        houseAccountId,
        CIRCLE_CARD_PROGRAM,
      );
      return community;
    } finally {
      await lockRunner.query(CIRCLE_CREATE_UNLOCK_SQL).catch(() => undefined);
      await lockRunner.release();
    }
  }

  /**
   * The circle when it has been founded, or null. A pure read that creates
   * nothing, for the reads (the admin summary, a staff seat release) that must
   * never found the circle as a side effect.
   */
  findCircle(): Promise<Community | null> {
    return this.findPinned();
  }

  private async findPinned(): Promise<Community | null> {
    const pin = await this.circlePin.findOne({ where: { id: CIRCLE_PIN_ID } });
    if (!pin) return null;
    return this.communities.findOne({ where: { id: pin.communityId } });
  }
}
