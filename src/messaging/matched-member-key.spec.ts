import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { extractMentions } from '../common/mentions';
import type { Profile } from '../users/entities/profile.entity';
import { matchedChatMentionRendererFrom } from './matched-chat-mention-text';
import {
  hasMatchedChatMentions,
  isMatchedChatMemberKey,
  matchedChatMemberKey,
  renderMatchedChatMentions,
  resolveMatchedChatMemberKeys,
} from './matched-member-key';
import {
  FULL_MEMBER_NAMES,
  matchedChatMemberNames,
  memberAvatarUrlFor,
} from './message-response';

/**
 * PRD-423 (opaque member keys): the per-chat key a matched Go together chat
 * names each member by.
 */
describe('matched chat member keys', () => {
  const CHAT = 'chat-1';
  const OTHER_CHAT = 'chat-2';
  const ANA = 'user-ana';
  const BEA = 'user-bea';

  it('is stable for one member of one chat and different in every other chat', () => {
    expect(matchedChatMemberKey(CHAT, ANA)).toBe(
      matchedChatMemberKey(CHAT, ANA),
    );
    expect(matchedChatMemberKey(CHAT, ANA)).not.toBe(
      matchedChatMemberKey(OTHER_CHAT, ANA),
    );
    expect(matchedChatMemberKey(CHAT, ANA)).not.toBe(
      matchedChatMemberKey(CHAT, BEA),
    );
  });

  it('never contains the user id or the conversation id', () => {
    const memberKey = matchedChatMemberKey(CHAT, ANA);

    expect(memberKey).not.toContain(ANA);
    expect(memberKey).not.toContain(CHAT);
    expect(isMatchedChatMemberKey(memberKey)).toBe(true);
    expect(isMatchedChatMemberKey('ana-sousa')).toBe(false);
    expect(isMatchedChatMemberKey(undefined)).toBe(false);
  });

  it("stays inside the mention tokenizer's slug alphabet, so `@key` parses as a member mention", () => {
    const memberKey = matchedChatMemberKey(CHAT, ANA);

    expect(extractMentions(`hey @${memberKey}, see you`).members).toEqual([
      memberKey,
    ]);
  });

  it("resolves a key among the chat's own seats alone", () => {
    const anaKey = matchedChatMemberKey(CHAT, ANA);
    const otherChatKey = matchedChatMemberKey(OTHER_CHAT, BEA);

    const resolved = resolveMatchedChatMemberKeys(
      CHAT,
      [ANA, BEA],
      [anaKey, otherChatKey, 'ana-sousa'],
    );

    expect([...resolved]).toEqual([[anaKey, ANA]]);
  });

  it('resolves nobody for a key of a member who holds no seat', () => {
    const anaKey = matchedChatMemberKey(CHAT, ANA);

    expect(resolveMatchedChatMemberKeys(CHAT, [BEA], [anaKey]).size).toBe(0);
  });

  describe('readable mentions (I5)', () => {
    const anaKey = matchedChatMemberKey(CHAT, ANA);
    const beaKey = matchedChatMemberKey(CHAT, BEA);
    const firstNames = new Map([
      [ANA, 'Ana'],
      [BEA, 'Bea'],
    ]);

    it('spells every key token by first name and leaves the rest as typed', () => {
      expect(
        renderMatchedChatMentions(
          `@${anaKey} and @${beaKey}, see you. me@${anaKey}x stays`,
          CHAT,
          [ANA, BEA],
          firstNames,
        ),
      ).toBe(`@Ana and @Bea, see you. me@${anaKey}x stays`);
      expect(hasMatchedChatMentions(`hi @${anaKey}`)).toBe(true);
      expect(hasMatchedChatMentions('hi @ana-sousa')).toBe(false);
    });

    it('reads a key naming nobody in the chat as a generic member', () => {
      const otherChatKey = matchedChatMemberKey(OTHER_CHAT, ANA);

      expect(
        renderMatchedChatMentions(
          `hey @${otherChatKey}`,
          CHAT,
          [ANA, BEA],
          firstNames,
        ),
      ).toBe('hey @Member');
    });

    it('renders per conversation from seats and profiles already loaded', () => {
      const render = matchedChatMentionRendererFrom(
        [
          { conversationId: CHAT, userId: ANA },
          { conversationId: CHAT, userId: BEA },
        ],
        [
          { userId: ANA, firstName: 'Ana' },
          { userId: BEA, firstName: 'Bea' },
        ],
      );

      expect(render(CHAT, `@${beaKey} hi`)).toBe('@Bea hi');
      expect(render(OTHER_CHAT, `@${beaKey} hi`)).toBe(`@${beaKey} hi`);
    });
  });

  describe('avatars (I4)', () => {
    beforeAll(() => setImageUrlBase('https://api.queerpulse.app'));
    afterAll(() => resetImageUrlBaseForTesting());

    const profile = {
      userId: ANA,
      // A provider avatar from sign-in, which identifies the account.
      avatarUrl: `https://photos.example.com/${ANA}.jpg`,
      photoVisible: true,
    } as Profile;

    it('serves a matched chat avatar from the conversation-scoped route, naming no user id', () => {
      const avatarUrl = memberAvatarUrlFor(
        profile,
        matchedChatMemberNames(CHAT),
      );

      expect(avatarUrl).toContain(
        `/matched-chat-avatars/${CHAT}/${matchedChatMemberKey(CHAT, ANA)}?v=`,
      );
      expect(avatarUrl).not.toContain(ANA);
    });

    it('keeps the ordinary URL elsewhere and hides a hidden photo everywhere', () => {
      expect(memberAvatarUrlFor(profile, FULL_MEMBER_NAMES)).toBe(
        `https://photos.example.com/${ANA}.jpg`,
      );
      expect(
        memberAvatarUrlFor(
          { ...profile, photoVisible: false },
          matchedChatMemberNames(CHAT),
        ),
      ).toBeNull();
    });
  });
});
