import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { IdentityStaffPreference } from './entities/identity-staff-preference.entity';
import { Identity, IdentityKind } from './entities/identity.entity';
import { IdentitiesService } from './identities.service';

export interface StaffNameInput {
  identity: Identity;
  senderUserId: string;
  senderFirstName: string;
  readerUserId: string;
}

/**
 * A resolver built once for a whole thread or page, so rendering many
 * messages never repeats the query cost of deciding attribution for one.
 * See `IdentityAttributionService.buildStaffNameResolver`, which is the only
 * way to build one.
 */
export interface StaffNameResolver {
  /** Synchronous. Every query it needs was made when the resolver was built. */
  resolve(
    senderIdentityId: string,
    senderUserId: string,
    senderFirstName: string,
  ): string | null;
}

/**
 * Final review I2: everything a `StaffNameResolver` reads apart from its
 * reader, loaded once for a set of identities. A caller that renders one
 * message for several readers loads it once and builds each reader's
 * resolver from the same rows, so every reader is judged against one
 * roster.
 */
export interface StaffNameResolverInputs {
  identityById: ReadonlyMap<string, Identity | null>;
  staffByIdentityId: ReadonlyMap<string, string[]>;
  preferenceByKey: ReadonlyMap<string, IdentityStaffPreference>;
}

/**
 * Decides whether a given reader sees which human answered from a mailbox.
 * Two switches must both allow it for a customer: the owner's mailbox switch
 * and the staff member's own. Colleagues inside the same mailbox always see
 * who replied, because a shared inbox that hides its own authors cannot be
 * worked in.
 */
@Injectable()
export class IdentityAttributionService {
  constructor(
    @InjectRepository(IdentityStaffPreference)
    private readonly preferences: Repository<IdentityStaffPreference>,
    private readonly identities: IdentitiesService,
  ) {}

  async resolveStaffFirstName(input: StaffNameInput): Promise<string | null> {
    const { identity, senderUserId, senderFirstName, readerUserId } = input;
    if (identity.kind === IdentityKind.Profile) {
      return null;
    }

    const staff = await this.identities.staffUserIds(identity.id);
    const isReaderStaff = staff.includes(readerUserId);
    if (isReaderStaff) {
      return senderFirstName;
    }

    if (!identity.shouldShowStaffNames) {
      return null;
    }
    const preference = await this.preferences.findOne({
      where: { identityId: identity.id, userId: senderUserId },
    });
    if (preference && !preference.shouldAllowNaming) {
      return null;
    }
    return senderFirstName;
  }

  /**
   * Builds one resolver for a whole thread or page. It loads every identity in
   * `identityIds`, each one's staff set, and every relevant staff preference
   * row up front, then answers per message with no further queries. A thread
   * has one or two distinct sender identities, so this is a small fixed cost
   * instead of a cost that grows with message count: rendering a 50-message
   * business thread through `resolveStaffFirstName` once per message costs 3
   * to 4 queries per call, all of it recomputing state identical for every
   * message in the thread; this builds that state exactly once.
   *
   * The returned `resolve` gives the SAME answer `resolveStaffFirstName`
   * would for identical inputs, including the reader-is-staff override, the
   * mailbox switch, and the absent-preference-row default, with one addition:
   * a blank or whitespace-only `senderFirstName` resolves to `null` here,
   * closing a minor ambiguity between a caller that tests truthiness and one
   * that tests `=== null`. `resolveStaffFirstName` itself is unchanged, for
   * the genuinely single-message paths (e.g. emitting one new message over
   * the socket) this pairs with.
   *
   * Every missing or unexpected input fails closed: an identity this resolver
   * never loaded, or one it could not resolve, answers `null` for every
   * sender under it, the same as an ordinary customer who is owed no name.
   */
  async buildStaffNameResolver(
    identityIds: string[],
    readerUserId: string,
    // Final review I2: rows a caller already loaded through
    // `loadStaffNameResolverInputs`, so several readers share one roster.
    preloadedInputs?: StaffNameResolverInputs,
  ): Promise<StaffNameResolver> {
    const { identityById, staffByIdentityId, preferenceByKey } =
      preloadedInputs ?? (await this.loadStaffNameResolverInputs(identityIds));
    return {
      resolve(
        senderIdentityId: string,
        senderUserId: string,
        senderFirstName: string,
      ): string | null {
        if (!senderFirstName.trim()) {
          return null;
        }
        const identity = identityById.get(senderIdentityId);
        if (!identity || identity.kind === IdentityKind.Profile) {
          return null;
        }
        const staff = staffByIdentityId.get(senderIdentityId) ?? [];
        if (staff.includes(readerUserId)) {
          return senderFirstName;
        }
        if (!identity.shouldShowStaffNames) {
          return null;
        }
        const preference = preferenceByKey.get(
          `${senderIdentityId}:${senderUserId}`,
        );
        if (preference && !preference.shouldAllowNaming) {
          return null;
        }
        return senderFirstName;
      },
    };
  }

  /**
   * Final review I2: the reader-free part of `buildStaffNameResolver`, for
   * `identityIds`. `preloaded` lets a caller supply identity rows and staff
   * lists it already read, so the resolver and the caller's own use of the
   * roster come from the same read. Anything not supplied is read here.
   */
  async loadStaffNameResolverInputs(
    identityIds: string[],
    preloaded: {
      identities?: ReadonlyArray<Identity>;
      staffUserIds?: (identityId: string) => Promise<string[]>;
    } = {},
  ): Promise<StaffNameResolverInputs> {
    const uniqueIdentityIds = [...new Set(identityIds)];
    const preloadedIdentityById = preloaded.identities
      ? new Map(preloaded.identities.map((identity) => [identity.id, identity]))
      : undefined;
    const loadedIdentities = preloadedIdentityById
      ? uniqueIdentityIds.map(
          (identityId) => preloadedIdentityById.get(identityId) ?? null,
        )
      : await Promise.all(
          uniqueIdentityIds.map((identityId) =>
            this.identities.getById(identityId),
          ),
        );
    const identityById = new Map<string, Identity | null>(
      uniqueIdentityIds.map((identityId, index) => [
        identityId,
        loadedIdentities[index] ?? null,
      ]),
    );

    // Only a non-profile identity ever needs a staff set or a preference row:
    // a profile identity's sender IS the member, so `resolveStaffFirstName`
    // always answers `null` for it before touching either.
    const mailboxIdentityIds = uniqueIdentityIds.filter((identityId) => {
      const identity = identityById.get(identityId);
      return identity != null && identity.kind !== IdentityKind.Profile;
    });

    const staffByIdentityId = new Map<string, string[]>();
    await Promise.all(
      mailboxIdentityIds.map(async (identityId) => {
        staffByIdentityId.set(
          identityId,
          await (preloaded.staffUserIds
            ? preloaded.staffUserIds(identityId)
            : this.identities.staffUserIds(identityId)),
        );
      }),
    );

    // ONE query for every mailbox identity's preference rows, never one per
    // identity: the query this whole method exists to stop repeating.
    const preferenceRows = mailboxIdentityIds.length
      ? await this.preferences.find({
          where: { identityId: In(mailboxIdentityIds) },
        })
      : [];
    const preferenceByKey = new Map<string, IdentityStaffPreference>(
      preferenceRows.map((row) => [`${row.identityId}:${row.userId}`, row]),
    );

    return { identityById, staffByIdentityId, preferenceByKey };
  }
}
