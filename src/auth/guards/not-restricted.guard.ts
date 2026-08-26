import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { CurrentUserData } from '../decorators/current-user.decorator';

/** Machine-readable code the frontend can key a "you're restricted" prompt
 *  off, mirroring `AFFIRMING_PLEDGE_REQUIRED_CODE`'s convention. */
export const ACCOUNT_RESTRICTED_CODE = 'ACCOUNT_RESTRICTED';

/**
 * Blocks one specific write action for a member under an active moderation
 * restriction (`ModActionCode.restrict` — see
 * `AccountEnforcementService.enforceAgainstUser`).
 *
 * Deliberately narrower than {@link ActiveMemberGuard}: a restriction is not a
 * lockout. The member keeps signing in, browsing, and taking every other
 * action normally — only the handlers this guard is bound to at the METHOD
 * level (never the controller) reject them. Reads `request.user.restricted`,
 * which `JwtStrategy.validate`/`liftExpiredRestriction` already computed fresh
 * (DB-backed, lazily expired) for this request — no second query here.
 *
 * Where to bind it (TS-09 settled this, so keep new routes consistent):
 *
 * - Bind it when the write reaches other members: creating or editing content
 *   others read (posts, replies, comments, reviews, listings, gatherings,
 *   jobs, volunteering calls, a published persona), sending
 *   something straight to a person (connection request, invite, enquiry,
 *   intro request, viewing request, hello), or lending the member's name to
 *   someone else (vouch, endorsement, recommendation).
 * - Leave it off when the write reaches only the member themselves or only
 *   staff: reads, own profile and account settings, saved lists and drafts,
 *   data export and deletion (a sanction never blocks a GDPR right), filing a
 *   report or an appeal, deactivating, leaving a community, blocking or
 *   muting, and any submission that sits in a staff queue until a moderator
 *   approves it (suggestions, nominations, applications, claims, disputes).
 * - Deletions, withdrawals and cancellations of the member's own things stay
 *   open: taking something down is the direction a restriction wants.
 * - Votes, reactions and ratings stay open, following the forum precedent
 *   where thread and reply creation are bound and `POST posts/:id/vote` is not.
 */
@Injectable()
export class NotRestrictedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (!user?.restricted) {
      return true;
    }
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message:
        'This action is unavailable while a moderation restriction is in effect.',
      code: ACCOUNT_RESTRICTED_CODE,
    });
  }
}
