// Which persona kinds read each kind-specific `skinData` key, derived from
// the frontend skin readers. Tattoo artists and therapists have their own
// layouts (`TattooBody` reads `skins/tattoo/tattooView.ts`, `TherapistBody`
// reads `skins/therapist/therapistView.ts`), and every other Practice kind
// renders `PracticeBody`, whose `PracticeVenue` block reads `venue` and whose
// `PracticeTraining` and `PracticeAvailability` blocks read `training` and
// `availability`. A
// persona that changes type keeps its stored `skinData` whole, so a switch
// back restores every block; the public view drops each mapped key the
// current kind does not read. Keys left out of the map (the family skin keys
// and the display preferences) are read by every kind that can hold them.

import { SubprofileKind, type SkinData } from './entities/subprofile.entity';

const TATTOO_ARTIST_ONLY: readonly SubprofileKind[] = Object.freeze([
  SubprofileKind.TattooArtist,
]);
const THERAPIST_ONLY: readonly SubprofileKind[] = Object.freeze([
  SubprofileKind.Therapist,
]);
// The Practice kinds that render `PracticeBody` (every Practice kind except
// the therapist, which has its own layout).
const PRACTICE_BODY_KINDS: readonly SubprofileKind[] = Object.freeze([
  SubprofileKind.Coach,
  SubprofileKind.Bodyworker,
  SubprofileKind.YogaTeacher,
  SubprofileKind.Nutritionist,
  SubprofileKind.Doula,
  SubprofileKind.PersonalTrainer,
  SubprofileKind.SexEducator,
  SubprofileKind.PeerSupport,
]);

export const SKIN_DATA_KEY_READERS: Readonly<
  Record<string, readonly SubprofileKind[]>
> = Object.freeze({
  tattoo: TATTOO_ARTIST_ONLY,
  tattooBooking: TATTOO_ARTIST_ONLY,
  tattooStyles: TATTOO_ARTIST_ONLY,
  tattooPrices: TATTOO_ARTIST_ONLY,
  tattooComfort: TATTOO_ARTIST_ONLY,
  tattooHygiene: TATTOO_ARTIST_ONLY,
  tattooScarWork: TATTOO_ARTIST_ONLY,
  tattooStudio: TATTOO_ARTIST_ONLY,
  tattooLineage: TATTOO_ARTIST_ONLY,
  therapist: THERAPIST_ONLY,
  lived: THERAPIST_ONLY,
  contexts: THERAPIST_ONLY,
  modalities: THERAPIST_ONLY,
  workingStyle: THERAPIST_ONLY,
  notFor: THERAPIST_ONLY,
  boundaries: THERAPIST_ONLY,
  whoFor: THERAPIST_ONLY,
  therapyFees: THERAPIST_ONLY,
  reimbursement: THERAPIST_ONLY,
  availabilitySummary: THERAPIST_ONLY,
  travel: THERAPIST_ONLY,
  accessMissing: THERAPIST_ONLY,
  worksAlongside: THERAPIST_ONLY,
  // `TherapistBody` reads these through `therapistView.ts`; `PracticeBody`
  // never renders them.
  hours: THERAPIST_ONLY,
  openSlots: THERAPIST_ONLY,
  // Read by both own layouts (`tattooView.ts` and `therapistView.ts`).
  faq: Object.freeze([SubprofileKind.Therapist, SubprofileKind.TattooArtist]),
  // The studio or practice address: `tattooView.ts` for tattoo artists,
  // `therapistView.helpers.ts` (`buildVenue`) for therapists, and
  // `PracticeVenue` inside `PracticeBody` for every other Practice kind.
  venue: Object.freeze([
    SubprofileKind.TattooArtist,
    SubprofileKind.Therapist,
    ...PRACTICE_BODY_KINDS,
  ]),
  // `PracticeTraining` and `PracticeAvailability` (`PracticeTherapistBlocks.tsx`)
  // render only inside `PracticeBody`; `TherapistBody` reads neither
  // `skinData.training` nor `skinData.availability`.
  training: PRACTICE_BODY_KINDS,
  availability: PRACTICE_BODY_KINDS,
});

/**
 * The `skinData` a visitor sees for a persona of this kind: a shallow copy
 * without each mapped key whose readers leave this kind out. Keys absent from
 * `SKIN_DATA_KEY_READERS` always pass, including a stored key that shares a
 * name with an `Object.prototype` member. The stored object is left untouched.
 */
export function publicSkinDataFor(
  kind: SubprofileKind,
  skinData: SkinData | null | undefined,
): SkinData | null {
  if (!skinData) {
    return null;
  }
  const publicEntries = Object.entries(skinData).filter(([key]) => {
    if (!Object.hasOwn(SKIN_DATA_KEY_READERS, key)) {
      return true;
    }
    const readers = SKIN_DATA_KEY_READERS[key];
    return readers === undefined || readers.includes(kind);
  });
  return Object.fromEntries(publicEntries);
}
