import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Not, Repository } from 'typeorm';
import { Invite, InviteStatus } from '../membership/entities/invite.entity';
import { InvitesService } from '../membership/invites.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  HOUSE_EMAIL,
  HOUSE_FIRST_NAME,
  HOUSE_GOOGLE_ID,
  HOUSE_LAST_NAME,
} from './genesis.constants';

/**
 * One-time platform bootstrap: the only way for the first member of an
 * invite-only platform to exist.
 *
 * The gate is closed from both sides — signup requires an invite, and
 * `invites.inviter_id` is NOT NULL with an FK to `users` — so the first user
 * cannot come into being without a deliberate escape hatch. This is it.
 *
 * Three independent gates, any one of which is sufficient:
 *
 * 1. `GENESIS_EMAIL` unset -> 404. The kill switch; unset it after use.
 * 2. The minted invite pins `email` to `GENESIS_EMAIL`, so redemption by any
 *    other Google account is rejected by `validateInviteForSignup` — machinery
 *    that already exists. THIS is why the endpoint needs no secret: the worst a
 *    stranger who finds `/genesis` can do is mint an invite only the founder
 *    can redeem.
 * 3. Minting 404s once any user other than the house account exists, so
 *    redeeming the invite permanently closes the endpoint that produced it.
 * 4. A one-way `genesis_bootstrap` marker, set on the first successful
 *    `claimAdmin`. Both mint and claim refuse once it exists, so re-triggering
 *    survives every admin later being removed while `GENESIS_EMAIL` is still
 *    set (finding L5) — the kill switch no longer depends on the operator
 *    remembering to unset the env var.
 *
 * Nothing here touches `AuthService` — redemption runs through the completely
 * unmodified signup path and produces an ordinary member. Admin is a separate,
 * explicit claim. That separation is the whole reason this module can be
 * deleted in one commit.
 */
@Injectable()
export class GenesisService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Invite) private readonly invites: Repository<Invite>,
    private readonly usersService: UsersService,
    private readonly invitesService: InvitesService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /**
   * The kill switch. Throws `NotFoundException` rather than a 401/403 so a
   * response never distinguishes "wrong caller" from "route does not exist".
   */
  private requireGenesisEmail(): string {
    const genesisEmail = this.config.get<string | null>('app.genesisEmail');
    if (!genesisEmail) {
      throw new NotFoundException();
    }
    return genesisEmail;
  }

  /**
   * The one-way consumed marker. Its presence means genesis was already
   * claimed at least once, and both endpoints stay closed forever after —
   * independent of the live admin/member counts, which can both fall back to
   * zero if accounts are later removed. See the `genesis_bootstrap` migration.
   *
   * Read/written by raw SQL against the injected `DataSource` rather than a
   * dedicated entity + repository, so the entire persistence footprint of this
   * hardening lives in one migration and this service — keeping the genesis
   * feature deletable in a single commit.
   */
  private async isGenesisConsumed(): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM "genesis_bootstrap" WHERE "id" = 1 LIMIT 1`,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  private async markGenesisConsumed(manager: EntityManager): Promise<boolean> {
    // Conditional insert: `RETURNING` yields the row only when THIS call won
    // the insert, so a concurrent second claim that hits the conflict gets an
    // empty result and knows it lost the race.
    const inserted = await manager.query(
      `INSERT INTO "genesis_bootstrap" ("id") VALUES (1)
       ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
    );
    return Array.isArray(inserted) && inserted.length > 0;
  }

  async mintGenesisInvite(): Promise<{ code: string }> {
    const genesisEmail = this.requireGenesisEmail();

    // Consumed once claimed — the endpoint that produced the invite stays shut
    // even if the founder's account is later removed, dropping the real-member
    // count back to zero.
    if (await this.isGenesisConsumed()) {
      throw new NotFoundException();
    }

    const houseAccount = await this.users.findOne({
      where: { googleId: HOUSE_GOOGLE_ID },
    });

    // The empty-platform gate. Counted EXCLUDING the house account, because the
    // house account is created by this very method — counting it would make the
    // endpoint close itself on its own first call.
    const realMemberCount = await this.users.count(
      houseAccount ? { where: { id: Not(houseAccount.id) } } : {},
    );
    if (realMemberCount > 0) {
      throw new NotFoundException();
    }

    if (houseAccount) {
      const existingInvite = await this.invites.findOne({
        where: { inviterId: houseAccount.id, status: InviteStatus.Pending },
      });
      if (existingInvite) {
        const notExpired =
          !existingInvite.expiresAt ||
          existingInvite.expiresAt.getTime() > Date.now();
        const pinMatches = existingInvite.email?.toLowerCase() === genesisEmail;
        // Idempotent: clicking the button twice must not litter the table with
        // invites, and must keep handing back a code that still works.
        if (notExpired && pinMatches) {
          return { code: existingInvite.code };
        }
        // The pin no longer matches (GENESIS_EMAIL was corrected after minting)
        // or the invite lapsed. Either way the old code is unredeemable, so
        // revoke it rather than leaving a live invite nobody can use.
        await this.invites.update(
          { id: existingInvite.id, status: InviteStatus.Pending },
          { status: InviteStatus.Revoked },
        );
      }
    }

    // One transaction: the house account and its invite commit or roll back
    // together, so there is never a house account with no invite behind it.
    return this.dataSource.transaction(async (manager) => {
      const inviter =
        houseAccount ??
        (await this.usersService.createGoogleUser(manager, {
          googleId: HOUSE_GOOGLE_ID,
          email: HOUSE_EMAIL,
          firstName: HOUSE_FIRST_NAME,
          lastName: HOUSE_LAST_NAME,
          // Active is REQUIRED, not cosmetic: `validateInviteForSignup`
          // rejects an invite whose inviter is not active. Role is left to the
          // column default (`member`) — the account never acts, and an idle
          // admin is standing privilege for no benefit. `isSystem` marks it as
          // the platform's non-human account so admins can edit its public
          // profile via `admin/bots` (its permission level stays `member`).
          status: UserStatus.Active,
          isSystem: true,
        }));

      // Reused verbatim rather than reimplemented: this already means
      // "platform-minted, quota-exempt, email-pinned, standard TTL", which is
      // exactly the genesis invite. It has no code-collision retry by design,
      // so a 23505 surfaces as a 500 with the transaction rolled back and the
      // founder clicks the button again.
      const invite = await this.invitesService.createInviteForApproval(
        manager,
        inviter.id,
        genesisEmail,
      );
      return { code: invite.code };
    });
  }

  /**
   * Promotes the founder to admin after they have redeemed the genesis invite
   * and become an ordinary member.
   *
   * Separate from signup on purpose. Granting admin inside
   * `validateOrCreateGoogleUser` would mean privilege-escalation logic living
   * permanently in the auth path; here it is an explicit act in a module built
   * to be deleted.
   */
  async claimAdmin(userId: string, email: string): Promise<void> {
    const genesisEmail = this.requireGenesisEmail();

    if (email.toLowerCase() !== genesisEmail) {
      throw new ForbiddenException('Not the genesis account');
    }

    // One-way consumed marker: the first successful claim closes this
    // permanently, independent of the live admin count. This is what stops the
    // genesis mailbox from re-promoting itself if every admin is later removed
    // while `GENESIS_EMAIL` is still set (finding L5).
    if (await this.isGenesisConsumed()) {
      throw new ForbiddenException('Genesis is closed');
    }

    // A pre-existing admin (a manually seeded one, say) means bootstrap already
    // happened by another route: close genesis for good rather than merely
    // rejecting this one call, so the mailbox can't slip through later if that
    // admin is removed.
    const adminCount = await this.users.count({
      where: { role: UserRole.Admin },
    });
    if (adminCount > 0) {
      await this.markGenesisConsumed(this.dataSource.manager);
      throw new ForbiddenException('Genesis is closed');
    }

    await this.dataSource.transaction(async (manager) => {
      // Claim the one-way marker first; losing the race (a concurrent claim
      // already inserted it) means we must not promote.
      const won = await this.markGenesisConsumed(manager);
      if (!won) {
        throw new ForbiddenException('Genesis is closed');
      }
      await manager.update(User, { id: userId }, { role: UserRole.Admin });
    });
  }
}
