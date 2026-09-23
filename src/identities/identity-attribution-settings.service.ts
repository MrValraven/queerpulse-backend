import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IdentityAttributionDto } from './dto/identity-attribution.dto';
import { IdentityStaffPreference } from './entities/identity-staff-preference.entity';
import { Identity, IdentityKind } from './entities/identity.entity';
import { IdentitiesService } from './identities.service';

/**
 * Task 20: who may read and change the two attribution switches
 * (`identities.should_show_staff_names` and a staff member's own row in
 * `identity_staff_preferences`), behind `GET`/`PATCH
 * /identities/:identityId/attribution` and `PUT
 * /identities/:identityId/staff-preferences/me`. `IdentitiesService` already
 * decides who may act as an identity at all; this service answers the
 * narrower question of who may change how that identity names its staff,
 * and returns the same shape `IdentityAttributionService` reads live on
 * every render.
 */
@Injectable()
export class IdentityAttributionSettingsService {
  constructor(
    private readonly identities: IdentitiesService,
    @InjectRepository(Identity)
    private readonly identityRepository: Repository<Identity>,
    @InjectRepository(IdentityStaffPreference)
    private readonly preferences: Repository<IdentityStaffPreference>,
  ) {}

  /**
   * Staff of `identityId` only, by `IdentitiesService.isAllowedToActAs`: a
   * moderation-removed persona's staff keep reading, the way they keep
   * reading its threads. A caller who is not staff, and a caller naming an
   * identity that does not exist, both get the identical `IDENTITY_NOT_STAFF`
   * refusal, so the route is no oracle for which identities exist or who
   * staffs them. A profile identity gets `IDENTITY_NOT_A_MAILBOX`, checked
   * only after the staff check passes, so a stranger learns nothing about
   * the kind either.
   */
  async getAttribution(
    userId: string,
    identityId: string,
  ): Promise<IdentityAttributionDto> {
    if (!(await this.identities.isAllowedToActAs(userId, identityId))) {
      throw this.notStaffRefusal();
    }
    const identity = await this.mailboxIdentity(identityId);
    return this.buildAttributionDto(identity, userId);
  }

  /**
   * Owner only. `assertMayActAs` runs first, so a moderation-removed persona
   * refuses with `IDENTITY_REMOVED` before ownership is even asked, in line
   * with "it speaks no more". A staff member who is not the owner is refused
   * `IDENTITY_NOT_OWNER` and nothing changes; the same refusal covers an
   * ownerless listing, where `ownerUserIdOf` answers null and no caller can
   * ever equal it, so the switch stays locked until the listing gains an
   * owner again.
   */
  async updateOwnerSwitch(
    userId: string,
    identityId: string,
    shouldShowStaffNames: boolean,
  ): Promise<IdentityAttributionDto> {
    await this.identities.assertMayActAs(userId, identityId);
    const identity = await this.mailboxIdentity(identityId);
    const ownerUserId = await this.identities.ownerUserIdOf(identity);
    if (ownerUserId !== userId) {
      throw new ForbiddenException({
        code: 'IDENTITY_NOT_OWNER',
        message: 'Only this mailbox owner may change this switch',
      });
    }
    await this.identityRepository.update(identity.id, {
      shouldShowStaffNames,
    });
    return this.buildAttributionDto(
      { ...identity, shouldShowStaffNames },
      userId,
    );
  }

  /**
   * Any staff member, for their own row only: this never lists or changes a
   * colleague's preference, which would be a roster by another name.
   * `assertMayActAs` runs first, so a moderation-removed persona's staff
   * cannot change it either. The write is one upsert statement against
   * `UQ_identity_staff_preferences`, so two devices toggling at once cannot
   * race a `findOne` then `save` into a unique violation, and writing `true`
   * still keeps the row: a row means someone chose, and the absent-row
   * default is also `true`, so both read the same.
   */
  async updateOwnStaffPreference(
    userId: string,
    identityId: string,
    shouldAllowNaming: boolean,
  ): Promise<IdentityAttributionDto> {
    await this.identities.assertMayActAs(userId, identityId);
    const identity = await this.mailboxIdentity(identityId);
    await this.preferences.query(
      `INSERT INTO "identity_staff_preferences" ("identity_id", "user_id", "should_allow_naming")
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT "UQ_identity_staff_preferences"
       DO UPDATE SET "should_allow_naming" = EXCLUDED."should_allow_naming"`,
      [identityId, userId, shouldAllowNaming],
    );
    return this.buildAttributionDto(identity, userId, shouldAllowNaming);
  }

  /**
   * The identity itself, refusing a profile identity as not a mailbox
   * (naming has no meaning for it). Callers reach this only once a staff or
   * `assertMayActAs` check already passed, so the identity is expected to
   * exist; the defensive null branch stays safe by answering the same
   * `IDENTITY_NOT_STAFF` refusal.
   */
  private async mailboxIdentity(identityId: string): Promise<Identity> {
    const identity = await this.identities.getById(identityId);
    if (!identity) {
      throw this.notStaffRefusal();
    }
    if (identity.kind === IdentityKind.Profile) {
      throw new BadRequestException({
        code: 'IDENTITY_NOT_A_MAILBOX',
        message: 'There is no mailbox to write to here',
      });
    }
    return identity;
  }

  private notStaffRefusal(): ForbiddenException {
    return new ForbiddenException({
      code: 'IDENTITY_NOT_STAFF',
      message: 'You cannot read this mailbox',
    });
  }

  /**
   * `shouldShowStaffNames` is `identity`'s own column. `shouldAllowMyName` is
   * the caller's own row, read fresh unless the caller just wrote it
   * (`knownShouldAllowMyName`), in which case no extra query is needed.
   * `isOwner` is `ownerUserIdOf(identity) === userId`.
   */
  private async buildAttributionDto(
    identity: Identity,
    userId: string,
    knownShouldAllowMyName?: boolean,
  ): Promise<IdentityAttributionDto> {
    const [ownerUserId, shouldAllowMyName] = await Promise.all([
      this.identities.ownerUserIdOf(identity),
      knownShouldAllowMyName === undefined
        ? this.ownStaffPreference(identity.id, userId)
        : Promise.resolve(knownShouldAllowMyName),
    ]);
    return {
      shouldShowStaffNames: identity.shouldShowStaffNames,
      shouldAllowMyName,
      isOwner: ownerUserId === userId,
    };
  }

  private async ownStaffPreference(
    identityId: string,
    userId: string,
  ): Promise<boolean> {
    const preference = await this.preferences.findOne({
      where: { identityId, userId },
    });
    return preference?.shouldAllowNaming ?? true;
  }
}
