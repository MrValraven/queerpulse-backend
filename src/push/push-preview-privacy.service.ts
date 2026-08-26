import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { GENERIC_PUSH_COPY, type GenericPushCopy } from './generic-push-copy';
import { PushService, type PushPayload } from './push.service';

/**
 * THE ONE PLACE A PUSH IS SPLIT BY LOCK-SCREEN PRIVACY (ID-13).
 *
 * ---------------------------------------------------------------------------
 * Why this cannot be done in the service worker
 * ---------------------------------------------------------------------------
 * "Hide notification previews" shipped as an IndexedDB flag that `sw.ts` read
 * inside its `push` handler, rewriting the title and body before
 * `showNotification`. That works on Chrome, Firefox and every desktop engine.
 *
 * It does nothing at all on an iPhone. iOS never runs the service worker's push
 * handler JavaScript: it decrypts the payload and renders the plain-text `title`
 * and `body` fields itself. So a member who switched the toggle on saw a UI
 * saying previews were hidden while their lock screen kept printing
 * "Mariana: are you still coming on Thursday?" to whoever was in the room. That
 * is the exact harm the feature was written to prevent, failing silently, on the
 * platform where lock-screen previews are hardest to avoid seeing.
 *
 * The only fix is to never put the name in the payload. That decision has to be
 * made by the composer, per recipient, which is what this service does.
 *
 * ---------------------------------------------------------------------------
 * How it works
 * ---------------------------------------------------------------------------
 * `PushService.sendToUsers` takes a LIST of recipients and one payload, so a
 * batch whose recipients disagree about previews is split in two and sent
 * twice: the rich payload to everyone who has previews on, a generic one to
 * everyone who has them off. Two sends, two subscription queries, and never a
 * per-recipient loop.
 *
 * Every caller in `src/push` goes through here rather than calling
 * `sendToUsers` directly, so a new notification type is private by construction
 * instead of by remembering to add a branch.
 *
 * FAIL CLOSED. An absent `member_preferences` row (the majority of members,
 * since reads never create one) means hidden, matching
 * `DEFAULT_HIDE_PUSH_PREVIEWS`.
 * Only an explicit `hide_push_previews = false` puts a name on a lock screen.
 */
@Injectable()
export class PushPreviewPrivacyService {
  constructor(
    @InjectRepository(MemberPreferences)
    private readonly preferences: Repository<MemberPreferences>,
    private readonly pushService: PushService,
  ) {}

  /**
   * Deliver one notification to a batch of recipients, honouring each one's
   * lock-screen-preview setting.
   *
   * `richPayload` is the full copy: the sender's name, the event title, the
   * actor's avatar. `genericCopy` is what replaces the title and body for
   * anyone hiding previews; it defaults to "QueerPulse / You have a new
   * notification." and callers pass a per-category variant where one reads
   * better (a DM says a message arrived, not a notification).
   */
  async sendSplitByPreviewPreference(
    recipientUserIds: string[],
    richPayload: PushPayload,
    genericCopy: GenericPushCopy = GENERIC_PUSH_COPY.notification,
  ): Promise<void> {
    if (recipientUserIds.length === 0) return;

    const showingUserIds =
      await this.recipientsShowingPreviews(recipientUserIds);
    const showing = new Set(showingUserIds);
    const hidingUserIds = recipientUserIds.filter(
      (userId) => !showing.has(userId),
    );

    // Both sends run concurrently and neither is allowed to be skipped because
    // the other threw. `sendToUsers` already swallows per-endpoint failures,
    // so a rejection here is a database fault, not a delivery one.
    await Promise.all([
      this.pushService.sendToUsers(showingUserIds, richPayload),
      this.pushService.sendToUsers(
        hidingUserIds,
        toGenericPayload(richPayload, genericCopy),
      ),
    ]);
  }

  /**
   * The subset of `userIds` who have explicitly asked to SEE previews, in one
   * batched query for the whole notification batch, in the same spirit as
   * `NotificationPreferencesService.recipientsPushEnabled`.
   *
   * Deliberately the positive list rather than the negative one. Building the
   * hiding set from rows would silently omit every member without a row, and
   * "no row" is the common case; asking for the opt-outs instead means a
   * missing row, a failed lookup or a member added mid-flight all land on the
   * private side of the branch.
   */
  private async recipientsShowingPreviews(
    userIds: string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.preferences.find({
      where: { userId: In(userIds) },
      select: { userId: true, hidePushPreviews: true },
    });
    return rows
      .filter((row) => row.hidePushPreviews === false)
      .map((row) => row.userId);
  }
}

/**
 * Strip a payload down to what may be shown on a locked phone.
 *
 * An ALLOWLIST, never a spread-and-delete. `PushPayload` will grow fields, and
 * a future one that happens to be identifying (a sender handle, a thumbnail)
 * must not reach a hidden-preview notification because nobody remembered to
 * exclude it. Anything not named here is dropped.
 *
 * What survives, and why each is safe:
 * - `tag`: an opaque id (a conversation id, `notification:{uuid}`). Never
 *   rendered; it is what lets the service worker replace rather than stack.
 * - `data.url` / `data.conversationId`: the deep link the tap opens. Not
 *   rendered on the lock screen, and dropping it would leave the member with a
 *   notification that opens nowhere.
 * - `timestamp`: when the underlying thing happened. A time, nothing more.
 * - `renotify`: whether a replacement re-alerts. Carries no content.
 *
 * What is dropped, and why:
 * - `icon`: the ACTOR'S AVATAR on most types. A face on the lock screen names
 *   the sender as surely as the text does.
 * - `image`: a preview image is at least as identifying as the body.
 * - `actions`: button labels are one more surface to keep private, and iOS
 *   ignores them anyway.
 * - `l10n.params`: this is where the resolved name, event title and space name
 *   live. The generic keys take no parameters, so the params are not merely
 *   unused, they must not travel: the payload is decrypted on the device and a
 *   name sitting in it is a name that leaked, rendered or not.
 */
function toGenericPayload(
  richPayload: PushPayload,
  genericCopy: GenericPushCopy,
): PushPayload {
  return {
    title: genericCopy.title,
    body: genericCopy.body,
    tag: richPayload.tag,
    data: richPayload.data,
    ...(richPayload.timestamp !== undefined
      ? { timestamp: richPayload.timestamp }
      : {}),
    ...(richPayload.renotify !== undefined
      ? { renotify: richPayload.renotify }
      : {}),
    l10n: {
      titleKey: genericCopy.titleKey,
      bodyKey: genericCopy.bodyKey,
    },
  };
}
