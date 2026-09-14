import {
  closenessFor,
  pickCloseness,
  sharedCraft,
  sharedOpenTo,
  type ClosenessFacts,
  type ClosenessSignals,
} from './related-closeness';

const NONE: ClosenessSignals = {
  vouchedForOwner: false,
  ownerVouchedFor: false,
  sharedCommunity: null,
  sharedOpenTo: null,
  sharedCraft: null,
  sharedHood: null,
};

describe('pickCloseness', () => {
  it('returns null when every signal is absent', () => {
    expect(pickCloseness(NONE)).toBeNull();
  });

  it('ranks a vouch received by the owner above every other signal', () => {
    expect(
      pickCloseness({
        ...NONE,
        vouchedForOwner: true,
        ownerVouchedFor: true,
        sharedCommunity: 'Editorial Reading Circle',
        sharedOpenTo: { kind: 'preset', id: 'casualMeetups' },
        sharedCraft: 'Ceramics',
        sharedHood: 'Marvila',
      }),
    ).toEqual({ kind: 'vouchedForOwner', value: null });
  });

  it('ranks the vouch the owner gave above a shared community', () => {
    expect(
      pickCloseness({
        ...NONE,
        ownerVouchedFor: true,
        sharedCommunity: 'Editorial Reading Circle',
      }),
    ).toEqual({ kind: 'ownerVouchedFor', value: null });
  });

  it('ranks a shared community above a shared open-to chip', () => {
    expect(
      pickCloseness({
        ...NONE,
        sharedCommunity: 'Editorial Reading Circle',
        sharedOpenTo: { kind: 'preset', id: 'casualMeetups' },
      }),
    ).toEqual({ kind: 'community', value: 'Editorial Reading Circle' });
  });

  it('ranks a shared open-to chip above the craft/neighbourhood floor', () => {
    expect(
      pickCloseness({
        ...NONE,
        sharedOpenTo: { kind: 'preset', id: 'casualMeetups' },
        sharedCraft: 'Ceramics',
        sharedHood: 'Marvila',
      }),
    ).toEqual({ kind: 'openToPreset', value: 'casualMeetups' });
  });

  it('sends a custom open-to chip as its label, under its own kind', () => {
    expect(
      pickCloseness({
        ...NONE,
        sharedOpenTo: { kind: 'custom', label: 'Kiln share' },
      }),
    ).toEqual({ kind: 'openToCustom', value: 'Kiln share' });
  });

  it('ranks a shared craft above a shared neighbourhood', () => {
    expect(
      pickCloseness({
        ...NONE,
        sharedCraft: 'Ceramics',
        sharedHood: 'Marvila',
      }),
    ).toEqual({ kind: 'craft', value: 'Ceramics' });
  });

  it('falls back to the neighbourhood', () => {
    expect(pickCloseness({ ...NONE, sharedHood: 'Marvila' })).toEqual({
      kind: 'hood',
      value: 'Marvila',
    });
  });
});

describe('sharedOpenTo', () => {
  it('matches presets by id and keeps the owner chip order', () => {
    expect(
      sharedOpenTo(
        [
          { kind: 'preset', id: 'mentoring' },
          { kind: 'preset', id: 'casualMeetups' },
        ],
        [
          { kind: 'preset', id: 'casualMeetups' },
          { kind: 'preset', id: 'mentoring' },
        ],
      ),
    ).toEqual({ kind: 'preset', id: 'mentoring' });
  });

  it('matches customs case-insensitively and returns the owner spelling', () => {
    expect(
      sharedOpenTo(
        [{ kind: 'custom', label: 'Kiln share' }],
        [{ kind: 'custom', label: '  kiln SHARE ' }],
      ),
    ).toEqual({ kind: 'custom', label: 'Kiln share' });
  });

  it('never matches a preset id against a custom label', () => {
    expect(
      sharedOpenTo(
        [{ kind: 'preset', id: 'casualMeetups' }],
        [{ kind: 'custom', label: 'casualMeetups' }],
      ),
    ).toBeNull();
  });
});

describe('sharedCraft', () => {
  it('returns the owner spelling of the first tag both listed', () => {
    expect(sharedCraft(['Ceramics', 'Glaze'], ['glaze', 'ceramics'])).toBe(
      'Ceramics',
    );
  });

  it('returns null with no overlap', () => {
    expect(sharedCraft(['Ceramics'], ['NestJS'])).toBeNull();
  });
});

const FACTS: ClosenessFacts = {
  ownerVouchersVisible: true,
  theirVouchersVisible: true,
  theyVouchedForOwner: false,
  ownerVouchedForThem: false,
  sharedCommunity: null,
  theirProfileOpen: true,
  ownerOpenTo: [],
  theirOpenTo: [],
  ownerTags: [],
  theirTags: [],
  ownerHood: null,
  theirHood: null,
};

describe('closenessFor gates', () => {
  it('drops the received vouch when the owner hid their vouchers', () => {
    expect(
      closenessFor({
        ...FACTS,
        theyVouchedForOwner: true,
        ownerVouchersVisible: false,
      }),
    ).toBeNull();
  });

  it('drops the given vouch when THEY hid their vouchers', () => {
    expect(
      closenessFor({
        ...FACTS,
        ownerVouchedForThem: true,
        theirVouchersVisible: false,
      }),
    ).toBeNull();
  });

  it('falls through to a weaker visible signal rather than showing nothing', () => {
    expect(
      closenessFor({
        ...FACTS,
        theyVouchedForOwner: true,
        ownerVouchersVisible: false,
        sharedCommunity: 'Editorial Reading Circle',
      }),
    ).toEqual({ kind: 'community', value: 'Editorial Reading Circle' });
  });

  it('gates each roster independently', () => {
    expect(
      closenessFor({
        ...FACTS,
        theyVouchedForOwner: true,
        ownerVouchedForThem: true,
        ownerVouchersVisible: false,
      }),
    ).toEqual({ kind: 'ownerVouchedFor', value: null });
  });

  it('drops open-to when their profile is not open', () => {
    expect(
      closenessFor({
        ...FACTS,
        theirProfileOpen: false,
        ownerOpenTo: [{ kind: 'preset', id: 'casualMeetups' }],
        theirOpenTo: [{ kind: 'preset', id: 'casualMeetups' }],
        ownerTags: ['Ceramics'],
        theirTags: ['Ceramics'],
      }),
    ).toEqual({ kind: 'craft', value: 'Ceramics' });
  });

  it('never matches a hood against a hidden one', () => {
    // Both `null` means "hidden" on one side and "unset" on the other, and a
    // chip must not be able to tell those apart, nor pair two of them.
    expect(
      closenessFor({ ...FACTS, ownerHood: null, theirHood: null }),
    ).toBeNull();
    expect(
      closenessFor({ ...FACTS, ownerHood: 'Marvila', theirHood: null }),
    ).toBeNull();
    expect(
      closenessFor({ ...FACTS, ownerHood: 'Marvila', theirHood: 'Marvila' }),
    ).toEqual({ kind: 'hood', value: 'Marvila' });
  });
});
