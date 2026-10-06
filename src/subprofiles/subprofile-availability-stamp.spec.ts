import type { SkinData, Subprofile } from './entities/subprofile.entity';
import {
  availabilityUpdatedAtAfterSave,
  hasCapacityChanged,
} from './subprofile-availability-stamp';

type StampFields = Pick<
  Subprofile,
  'availability' | 'skinData' | 'availabilityUpdatedAt'
>;

const committedStamp = new Date('2026-05-01T10:00:00Z');
const saveTime = new Date('2026-10-06T12:00:00Z');

/** A skin with the therapist status block, the way the editor stores it. */
function therapistSkin(status: string): SkinData {
  return { therapist: { status } } as unknown as SkinData;
}

function row(overrides: Partial<StampFields> = {}): StampFields {
  return {
    availability: 'open_to_collabs',
    skinData: therapistSkin('open'),
    availabilityUpdatedAt: committedStamp,
    ...overrides,
  };
}

describe('hasCapacityChanged', () => {
  it('is false when the availability and the therapist status both match', () => {
    expect(hasCapacityChanged(row(), row())).toBe(false);
  });

  it('is true when the availability moves', () => {
    expect(hasCapacityChanged(row(), row({ availability: 'booking' }))).toBe(
      true,
    );
  });

  it('is true when only the therapist status moves', () => {
    expect(
      hasCapacityChanged(row(), row({ skinData: therapistSkin('wait') })),
    ).toBe(true);
  });

  it('is true when the availability is cleared', () => {
    expect(hasCapacityChanged(row(), row({ availability: null }))).toBe(true);
  });

  it('ignores skin edits that leave the therapist status alone', () => {
    const edited = row({
      skinData: {
        therapist: { status: 'open', quote: 'A new quote' },
        lived: ['Trans'],
      } as unknown as SkinData,
    });
    expect(hasCapacityChanged(row(), edited)).toBe(false);
  });

  it('reads a missing or malformed therapist block as no status', () => {
    const noStatus = row({ availability: null, skinData: null });
    expect(
      hasCapacityChanged(
        noStatus,
        row({
          availability: null,
          skinData: { therapist: 'open' } as unknown as SkinData,
        }),
      ),
    ).toBe(false);
    expect(
      hasCapacityChanged(
        noStatus,
        row({
          availability: null,
          skinData: { therapist: { status: 3 } } as unknown as SkinData,
        }),
      ),
    ).toBe(false);
  });
});

describe('availabilityUpdatedAtAfterSave', () => {
  it('stamps the save time when the availability changes', () => {
    expect(
      availabilityUpdatedAtAfterSave(
        row(),
        row({ availability: 'not_available' }),
        saveTime,
      ),
    ).toBe(saveTime);
  });

  it('stamps the save time when the therapist status changes', () => {
    expect(
      availabilityUpdatedAtAfterSave(
        row(),
        row({ skinData: therapistSkin('closed') }),
        saveTime,
      ),
    ).toBe(saveTime);
  });

  it('stamps a first status on a persona that never stated one', () => {
    expect(
      availabilityUpdatedAtAfterSave(
        row({
          availability: null,
          skinData: null,
          availabilityUpdatedAt: null,
        }),
        row({ availabilityUpdatedAt: null }),
        saveTime,
      ),
    ).toBe(saveTime);
  });

  it('keeps the committed stamp when nothing about the status moved', () => {
    expect(availabilityUpdatedAtAfterSave(row(), row(), saveTime)).toBe(
      committedStamp,
    );
  });

  it('keeps the committed stamp over an older one carried by a stale copy', () => {
    const staleCopy = row({
      availabilityUpdatedAt: new Date('2025-01-01T00:00:00Z'),
    });
    expect(availabilityUpdatedAtAfterSave(row(), staleCopy, saveTime)).toBe(
      committedStamp,
    );
  });

  it('stamps the save time when the owner confirms an unchanged status', () => {
    expect(availabilityUpdatedAtAfterSave(row(), row(), saveTime, true)).toBe(
      saveTime,
    );
  });

  it('stamps a confirmation over a stale copy too', () => {
    const staleCopy = row({
      availabilityUpdatedAt: new Date('2025-01-01T00:00:00Z'),
    });
    expect(
      availabilityUpdatedAtAfterSave(row(), staleCopy, saveTime, true),
    ).toBe(saveTime);
  });

  it('keeps null for a persona that states no status at all', () => {
    const silent = row({
      availability: null,
      skinData: null,
      availabilityUpdatedAt: null,
    });
    expect(availabilityUpdatedAtAfterSave(silent, silent, saveTime)).toBeNull();
  });
});
