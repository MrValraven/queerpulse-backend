import { HttpException } from '@nestjs/common';
import {
  DIRECTORY_PARTNER_REFUSALS,
  directoryPartnerError,
  type DirectoryPartnerRefusalReason,
} from './directory-partners.constants';
import {
  listsEveryIdOnce,
  normalizePartnerNote,
  partnerPublicStateOf,
} from './directory-partners.rules';
import {
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';

const LIVE_OPEN_LISTING = {
  status: ListingStatus.Live,
  operatingState: ListingOperatingState.Open,
  isHiddenByOwner: false,
  cats: ['food'],
};

function reasonOfSync(callback: () => unknown): {
  reason: string;
  status: number;
} {
  try {
    callback();
  } catch (error) {
    const httpError = error as HttpException;
    return {
      reason: (httpError.getResponse() as { reason: string }).reason,
      status: httpError.getStatus(),
    };
  }
  throw new Error('The callback did not throw');
}

describe('partnerPublicStateOf', () => {
  it('reads showing for a live, open, owner-shown, unmoderated listing outside 18+', () => {
    expect(partnerPublicStateOf(LIVE_OPEN_LISTING, false)).toBe('showing');
  });

  it('keeps a temporarily closed or moved listing showing, as the grid does', () => {
    expect(
      partnerPublicStateOf(
        {
          ...LIVE_OPEN_LISTING,
          operatingState: ListingOperatingState.TemporarilyClosed,
        },
        false,
      ),
    ).toBe('showing');
    expect(
      partnerPublicStateOf(
        { ...LIVE_OPEN_LISTING, operatingState: ListingOperatingState.Moved },
        false,
      ),
    ).toBe('showing');
  });

  it('answers the first matching reason in contract order', () => {
    const everyReason = {
      status: ListingStatus.Review,
      operatingState: ListingOperatingState.PermanentlyClosed,
      isHiddenByOwner: true,
      cats: ['intimacy'],
    };
    expect(partnerPublicStateOf(everyReason, true)).toBe('not_live');
    expect(
      partnerPublicStateOf(
        { ...everyReason, status: ListingStatus.Live },
        true,
      ),
    ).toBe('closed_for_good');
    expect(
      partnerPublicStateOf(
        {
          ...everyReason,
          status: ListingStatus.Live,
          operatingState: ListingOperatingState.Open,
        },
        true,
      ),
    ).toBe('hidden_by_owner');
    expect(
      partnerPublicStateOf({ ...LIVE_OPEN_LISTING, cats: ['intimacy'] }, true),
    ).toBe('moderated');
    expect(
      partnerPublicStateOf(
        { ...LIVE_OPEN_LISTING, cats: ['food', 'intimacy'] },
        false,
      ),
    ).toBe('adult_only');
  });

  it('reads a listing in the question status as not_live', () => {
    expect(
      partnerPublicStateOf(
        { ...LIVE_OPEN_LISTING, status: ListingStatus.Question },
        false,
      ),
    ).toBe('not_live');
  });
});

describe('normalizePartnerNote', () => {
  it('trims a note and stores a blank one as null', () => {
    expect(normalizePartnerNote('  Members get 10% off ')).toBe(
      'Members get 10% off',
    );
    expect(normalizePartnerNote('   ')).toBeNull();
    expect(normalizePartnerNote(null)).toBeNull();
    expect(normalizePartnerNote(undefined)).toBeNull();
  });

  it('accepts 140 characters counted as code points, emoji included', () => {
    expect(normalizePartnerNote('🌈'.repeat(140))).toBe('🌈'.repeat(140));
    expect(normalizePartnerNote(` ${'a'.repeat(140)} `)).toBe('a'.repeat(140));
  });

  it('refuses 141 characters after trimming with note_too_long', () => {
    expect(reasonOfSync(() => normalizePartnerNote('a'.repeat(141)))).toEqual({
      reason: 'note_too_long',
      status: 400,
    });
    expect(reasonOfSync(() => normalizePartnerNote('🌈'.repeat(141)))).toEqual({
      reason: 'note_too_long',
      status: 400,
    });
  });
});

describe('listsEveryIdOnce', () => {
  it('accepts every id once in any order and any letter case', () => {
    expect(listsEveryIdOnce(['aaa', 'bbb', 'ccc'], ['ccc', 'aaa', 'bbb'])).toBe(
      true,
    );
    expect(listsEveryIdOnce(['abc-def'], ['ABC-DEF'])).toBe(true);
  });

  it('refuses a repeated, a missing, an extra or a foreign id', () => {
    expect(listsEveryIdOnce(['aaa', 'bbb'], ['aaa', 'aaa'])).toBe(false);
    expect(listsEveryIdOnce(['aaa', 'bbb'], ['aaa'])).toBe(false);
    expect(listsEveryIdOnce(['aaa', 'bbb'], ['aaa', 'bbb', 'ccc'])).toBe(false);
    expect(listsEveryIdOnce(['aaa', 'bbb'], ['aaa', 'ccc'])).toBe(false);
  });

  it('accepts two empty lists', () => {
    expect(listsEveryIdOnce([], [])).toBe(true);
  });
});

describe('directoryPartnerError', () => {
  it.each([
    ['listing_not_found', 404],
    ['partner_not_found', 404],
    ['listing_not_live', 409],
    ['listing_adult_only', 409],
    ['already_partner', 409],
    ['partner_limit_reached', 409],
    ['note_too_long', 400],
    ['order_mismatch', 409],
  ] as const)(
    'answers %s with status %i and the reason in the body',
    (reason, status) => {
      const error = directoryPartnerError(reason);
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toEqual({
        statusCode: status,
        message: expect.any(String) as string,
        reason,
      });
    },
  );

  it('gives every reason its own message', () => {
    const reasons = Object.keys(
      DIRECTORY_PARTNER_REFUSALS,
    ) as DirectoryPartnerRefusalReason[];
    const messages = reasons.map(
      (reason) =>
        (directoryPartnerError(reason).getResponse() as { message: string })
          .message,
    );
    expect(reasons).toHaveLength(8);
    expect(new Set(messages).size).toBe(8);
  });
});
