import { SubprofileKind } from './entities/subprofile.entity';
import type { SkinData } from './entities/subprofile.entity';
import {
  availabilityAfterTattooSync,
  tattooBooksStatusOf,
} from './tattoo-books-status';

function tattooSkin(tattoo: unknown): SkinData {
  return { tattoo } as unknown as SkinData;
}

describe('availabilityAfterTattooSync', () => {
  it('maps waitlist to booking whatever availability was sent', () => {
    expect(
      availabilityAfterTattooSync(
        SubprofileKind.TattooArtist,
        tattooSkin({ status: 'waitlist' }),
        'open_to_collabs',
      ),
    ).toBe('booking');
  });

  it('maps open to open_to_collabs and closed to not_available', () => {
    expect(
      availabilityAfterTattooSync(
        SubprofileKind.TattooArtist,
        tattooSkin({ status: 'open' }),
        'not_available',
      ),
    ).toBe('open_to_collabs');
    expect(
      availabilityAfterTattooSync(
        SubprofileKind.TattooArtist,
        tattooSkin({ status: 'closed' }),
        null,
      ),
    ).toBe('not_available');
  });

  it('keeps the sent availability when the tattoo block has no status', () => {
    const sent = 'booking';
    expect(
      availabilityAfterTattooSync(SubprofileKind.TattooArtist, undefined, sent),
    ).toBe(sent);
    expect(
      availabilityAfterTattooSync(
        SubprofileKind.TattooArtist,
        tattooSkin(null),
        sent,
      ),
    ).toBe(sent);
    expect(
      availabilityAfterTattooSync(
        SubprofileKind.TattooArtist,
        tattooSkin({}),
        sent,
      ),
    ).toBe(sent);
    expect(
      availabilityAfterTattooSync(
        SubprofileKind.TattooArtist,
        tattooSkin({ status: 'wait' }),
        sent,
      ),
    ).toBe(sent);
  });

  it('leaves other kinds as sent', () => {
    expect(
      availabilityAfterTattooSync(
        SubprofileKind.Therapist,
        tattooSkin({ status: 'closed' }),
        'open_to_collabs',
      ),
    ).toBe('open_to_collabs');
  });
});

describe('tattooBooksStatusOf', () => {
  it('returns listed statuses only', () => {
    expect(tattooBooksStatusOf(tattooSkin({ status: 'open' }))).toBe('open');
    expect(tattooBooksStatusOf(tattooSkin({ status: 'wait' }))).toBeNull();
    expect(tattooBooksStatusOf(tattooSkin('open'))).toBeNull();
    expect(tattooBooksStatusOf(null)).toBeNull();
  });
});
