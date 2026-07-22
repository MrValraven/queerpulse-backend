import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
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

  async mintGenesisInvite(): Promise<{ code: string }> {
    const genesisEmail = this.requireGenesisEmail();

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

    // Self-disabling: the first successful claim closes this permanently.
    const adminCount = await this.users.count({
      where: { role: UserRole.Admin },
    });
    if (adminCount > 0) {
      throw new ForbiddenException('Genesis is closed');
    }

    await this.users.update({ id: userId }, { role: UserRole.Admin });
  }
}
