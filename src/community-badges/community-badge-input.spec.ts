import { HttpException } from '@nestjs/common';
import { CommunityBadgeRuleType } from './community-badges.catalog';
import {
  isCommunityBadgeUuid,
  normalizeBadgeCreate,
  normalizeBadgeName,
  normalizeBadgeThreshold,
  normalizeBadgeUpdate,
  normalizeFlairBadgeId,
  normalizeGiftHidden,
  normalizeGiftSend,
} from './community-badge-input';

/** Runs the thunk and answers the response body of the `HttpException` it
 *  throws. */
function responseOf(thunk: () => unknown): Record<string, unknown> {
  try {
    thunk();
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getResponse() as Record<string, unknown>;
    }
    throw error;
  }
  throw new Error('The thunk did not throw');
}

/** Runs the thunk and answers the reason code of the exception it throws. */
function codeOf(thunk: () => unknown): unknown {
  return responseOf(thunk).code;
}

function validCreateBody() {
  return {
    name: 'Regular',
    iconKey: 'star',
    tint: 'jade',
    ruleType: 'tenure_days',
    threshold: 90,
  };
}

describe('community badge input', () => {
  describe('normalizeBadgeCreate', () => {
    it('answers the first failure in contract order', () => {
      expect(
        codeOf(() =>
          normalizeBadgeCreate({
            name: '',
            iconKey: 'nope',
            tint: 'nope',
            ruleType: 'nope',
            threshold: 0,
          }),
        ),
      ).toBe('badge_name_required');
      expect(
        codeOf(() =>
          normalizeBadgeCreate({
            name: 'Regular',
            iconKey: 'nope',
            tint: 'nope',
          }),
        ),
      ).toBe('badge_icon_unknown');
      expect(
        codeOf(() =>
          normalizeBadgeCreate({
            name: 'Regular',
            iconKey: 'star',
            tint: 'gold',
          }),
        ),
      ).toBe('badge_tint_unknown');
      expect(
        codeOf(() =>
          normalizeBadgeCreate({
            name: 'Regular',
            iconKey: 'star',
            tint: 'jade',
            ruleType: 'karma',
          }),
        ),
      ).toBe('badge_rule_unknown');
    });

    it('checks the threshold after the rule', () => {
      expect(
        codeOf(() =>
          normalizeBadgeCreate({ ...validCreateBody(), threshold: 'x' }),
        ),
      ).toBe('badge_threshold_out_of_range');
    });

    it('defaults isEnabled to true and refuses a non boolean', () => {
      expect(normalizeBadgeCreate(validCreateBody()).isEnabled).toBe(true);
      expect(
        normalizeBadgeCreate({ ...validCreateBody(), isEnabled: false })
          .isEnabled,
      ).toBe(false);
      expect(
        codeOf(() =>
          normalizeBadgeCreate({ ...validCreateBody(), isEnabled: 'yes' }),
        ),
      ).toBe('badge_enabled_invalid');
    });

    it('answers every field of a valid body', () => {
      expect(normalizeBadgeCreate(validCreateBody())).toEqual({
        name: 'Regular',
        iconKey: 'star',
        tint: 'jade',
        ruleType: CommunityBadgeRuleType.TenureDays,
        threshold: 90,
        isEnabled: true,
      });
    });
  });

  describe('normalizeBadgeName', () => {
    it('strips markup from a name and counts code points', () => {
      expect(normalizeBadgeName('  <b>Night owls</b> ')).toBe('Night owls');
      expect(responseOf(() => normalizeBadgeName('x'.repeat(33)))).toEqual(
        expect.objectContaining({ code: 'badge_name_too_long', maxLength: 32 }),
      );
      expect(normalizeBadgeName('\u{1F308}'.repeat(32))).toHaveLength(64);
    });

    it.each([undefined, null, 5, '', '   ', '<b></b>'])(
      'answers badge_name_required for %p',
      (value) => {
        expect(codeOf(() => normalizeBadgeName(value))).toBe(
          'badge_name_required',
        );
      },
    );
  });

  describe('normalizeBadgeThreshold', () => {
    it.each([
      [CommunityBadgeRuleType.TenureDays, 29, 30, 3650],
      [CommunityBadgeRuleType.PostsAndReplies, 5001, 1, 5000],
    ])(
      'refuses %s threshold %p with its range',
      (ruleType, threshold, min, max) => {
        expect(
          responseOf(() => normalizeBadgeThreshold(threshold, ruleType)),
        ).toEqual(
          expect.objectContaining({
            code: 'badge_threshold_out_of_range',
            ruleType,
            min,
            max,
          }),
        );
      },
    );

    it('refuses a fractional threshold as out of range', () => {
      expect(
        codeOf(() =>
          normalizeBadgeThreshold(2.5, CommunityBadgeRuleType.EventsCheckedIn),
        ),
      ).toBe('badge_threshold_out_of_range');
    });

    it('accepts both ends of a range', () => {
      expect(
        normalizeBadgeThreshold(30, CommunityBadgeRuleType.TenureDays),
      ).toBe(30);
      expect(
        normalizeBadgeThreshold(3650, CommunityBadgeRuleType.TenureDays),
      ).toBe(3650);
    });
  });

  describe('normalizeBadgeUpdate', () => {
    it('locks the rule on an update that names one, even the same rule', () => {
      expect(
        codeOf(() =>
          normalizeBadgeUpdate(
            { ruleType: 'tenure_days' },
            CommunityBadgeRuleType.TenureDays,
          ),
        ),
      ).toBe('badge_rule_locked');
    });

    it('checks an updated threshold against the stored rule', () => {
      expect(
        normalizeBadgeUpdate(
          { threshold: 30 },
          CommunityBadgeRuleType.TenureDays,
        ),
      ).toEqual({ threshold: 30 });
      expect(
        normalizeBadgeUpdate({}, CommunityBadgeRuleType.TenureDays),
      ).toEqual({});
      expect(
        codeOf(() =>
          normalizeBadgeUpdate(
            { threshold: 501 },
            CommunityBadgeRuleType.EventsCheckedIn,
          ),
        ),
      ).toBe('badge_threshold_out_of_range');
    });

    it('returns only the keys present on the body', () => {
      expect(
        normalizeBadgeUpdate(
          { name: ' Moon ', isEnabled: false, tint: undefined },
          CommunityBadgeRuleType.TenureDays,
        ),
      ).toEqual({ name: 'Moon', isEnabled: false });
    });

    it('answers a present null name as required', () => {
      expect(
        codeOf(() =>
          normalizeBadgeUpdate(
            { name: null },
            CommunityBadgeRuleType.TenureDays,
          ),
        ),
      ).toBe('badge_name_required');
    });

    it('answers the rule lock before a bad threshold', () => {
      expect(
        codeOf(() =>
          normalizeBadgeUpdate(
            { ruleType: 'karma', threshold: 'x' },
            CommunityBadgeRuleType.TenureDays,
          ),
        ),
      ).toBe('badge_rule_locked');
    });
  });

  describe('flair badge id', () => {
    it('reads null as stop wearing and refuses a malformed id', () => {
      expect(normalizeFlairBadgeId(null)).toBeNull();
      expect(codeOf(() => normalizeFlairBadgeId('badge-1'))).toBe(
        'flair_badge_id_invalid',
      );
      expect(codeOf(() => normalizeFlairBadgeId(undefined))).toBe(
        'flair_badge_id_invalid',
      );
    });

    it('lowercases a uuid', () => {
      expect(
        normalizeFlairBadgeId('6F1C2A40-8B3D-4E5F-9A10-1B2C3D4E5F60'),
      ).toBe('6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60');
    });

    it('recognises a uuid string only', () => {
      expect(isCommunityBadgeUuid('6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60')).toBe(
        true,
      );
      expect(isCommunityBadgeUuid(5)).toBe(false);
      expect(isCommunityBadgeUuid('nope')).toBe(false);
    });
  });

  describe('normalizeGiftSend', () => {
    it('sanitises a gift note and stores a blank one as null', () => {
      expect(
        normalizeGiftSend({
          recipientSlug: 'mara',
          giftKey: 'heart',
          note: ' \u0007thanks\r\n ',
        }).note,
      ).toBe('thanks');
      expect(
        normalizeGiftSend({
          recipientSlug: 'mara',
          giftKey: 'heart',
          note: '   ',
        }).note,
      ).toBeNull();
      expect(
        responseOf(() =>
          normalizeGiftSend({
            recipientSlug: 'mara',
            giftKey: 'heart',
            note: 'x'.repeat(141),
          }),
        ),
      ).toEqual(
        expect.objectContaining({ code: 'gift_note_too_long', maxLength: 140 }),
      );
      expect(
        codeOf(() =>
          normalizeGiftSend({ recipientSlug: 'mara', giftKey: 'rose' }),
        ),
      ).toBe('gift_unknown');
    });

    it('reads an absent or null note as null', () => {
      expect(
        normalizeGiftSend({ recipientSlug: 'mara', giftKey: 'heart' }).note,
      ).toBeNull();
      expect(
        normalizeGiftSend({
          recipientSlug: 'mara',
          giftKey: 'heart',
          note: null,
        }).note,
      ).toBeNull();
    });

    it('accepts a note of exactly 140 code points', () => {
      expect(
        normalizeGiftSend({
          recipientSlug: 'mara',
          giftKey: 'heart',
          note: '\u{1F308}'.repeat(140),
        }).note,
      ).toHaveLength(280);
    });

    it.each([42, true, { text: 'hi' }])(
      'refuses the note %p with gift_note_invalid',
      (note) => {
        expect(
          codeOf(() =>
            normalizeGiftSend({
              recipientSlug: 'mara',
              giftKey: 'heart',
              note,
            }),
          ),
        ).toBe('gift_note_invalid');
      },
    );

    it.each([undefined, null, 7, '', '   '])(
      'answers gift_recipient_not_member for the recipient %p',
      (recipientSlug) => {
        expect(
          codeOf(() => normalizeGiftSend({ recipientSlug, giftKey: 'heart' })),
        ).toBe('gift_recipient_not_member');
      },
    );

    it('trims the recipient slug and answers the normalised send', () => {
      expect(
        normalizeGiftSend({
          recipientSlug: ' mara ',
          giftKey: 'life_buoy',
          note: 'thank you',
        }),
      ).toEqual({
        recipientSlug: 'mara',
        giftKey: 'life_buoy',
        note: 'thank you',
      });
    });

    it('answers the recipient failure before the gift failure', () => {
      expect(
        codeOf(() => normalizeGiftSend({ recipientSlug: '', giftKey: 'rose' })),
      ).toBe('gift_recipient_not_member');
    });
  });

  describe('normalizeGiftHidden', () => {
    it('refuses a hidden flag that is no boolean', () => {
      expect(codeOf(() => normalizeGiftHidden('true'))).toBe(
        'gift_hidden_invalid',
      );
      expect(codeOf(() => normalizeGiftHidden(undefined))).toBe(
        'gift_hidden_invalid',
      );
    });

    it('accepts both booleans', () => {
      expect(normalizeGiftHidden(true)).toBe(true);
      expect(normalizeGiftHidden(false)).toBe(false);
    });
  });
});
