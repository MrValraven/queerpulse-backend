import { toBareKey } from '../storage/bare-key';
import type {
  ItemStructured,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import {
  listItemImageRefs,
  type ItemImageCarrier,
} from './subprofile-item-images';
import { clientConsentRequired } from './tattoo-artist-errors';
import { isTattooBodyPhotoSection } from './tattoo-artist-vocab';

/**
 * Body-photo consent rule (contract "Body-photo consent rule").
 *
 * A body-photo item that carries an image outside the stored set of its
 * section needs `structured.photo.hasClientConsent === true`. Images already
 * stored in the same section save untouched, so a reorder of rows saved
 * before this rule existed goes through. Both sides compare as bare storage
 * keys, so a legacy `/files/<key>` value matches the bare key the editor
 * sends.
 */

/** The bare keys of every image the given rows store. */
export function storedImageSet(
  storedRows: readonly ItemImageCarrier[],
): Set<string> {
  const storedImages = new Set<string>();
  for (const storedRow of storedRows) {
    for (const imageRef of listItemImageRefs(storedRow)) {
      storedImages.add(toBareKey(imageRef));
    }
  }
  return storedImages;
}

function hasClientConsent(item: ItemImageCarrier): boolean {
  return item.structured?.photo?.hasClientConsent === true;
}

function hasUnstoredImage(
  item: ItemImageCarrier,
  storedImages: ReadonlySet<string>,
): boolean {
  return listItemImageRefs(item).some(
    (imageRef) => !storedImages.has(toBareKey(imageRef)),
  );
}

/**
 * The index of the first incoming item that brings a new image into a
 * body-photo section without client consent, or `null` when every item may
 * save. Sections outside the body-photo list always give `null`.
 */
export function findItemNeedingClientConsent(
  section: SubprofileSection,
  incomingItems: readonly ItemImageCarrier[],
  storedRows: readonly ItemImageCarrier[],
): number | null {
  if (!isTattooBodyPhotoSection(section)) return null;
  const storedImages = storedImageSet(storedRows);
  const itemIndex = incomingItems.findIndex(
    (incomingItem) =>
      hasUnstoredImage(incomingItem, storedImages) &&
      !hasClientConsent(incomingItem),
  );
  return itemIndex === -1 ? null : itemIndex;
}

/** Throws 400 `CLIENT_CONSENT_REQUIRED` `{ itemIndex }` for the first item
 * that needs client consent. */
export function assertClientConsentForNewImages(
  section: SubprofileSection,
  incomingItems: readonly ItemImageCarrier[],
  storedRows: readonly ItemImageCarrier[],
): void {
  const itemIndex = findItemNeedingClientConsent(
    section,
    incomingItems,
    storedRows,
  );
  if (itemIndex !== null) throw clientConsentRequired(itemIndex);
}

/**
 * The `structured` a revision restore writes. A body-photo snapshot that
 * brings back an image outside the stored set without client consent is
 * restored with consent false and blurred; every other snapshot keeps its
 * `structured` as it is. A restore never refuses.
 */
export function structuredForRestoredSnapshot(
  section: SubprofileSection,
  snapshot: ItemImageCarrier,
  storedImages: ReadonlySet<string>,
): ItemStructured | null {
  const snapshotStructured = snapshot.structured ?? null;
  if (!isTattooBodyPhotoSection(section)) return snapshotStructured;
  if (hasClientConsent(snapshot)) return snapshotStructured;
  if (!hasUnstoredImage(snapshot, storedImages)) return snapshotStructured;
  return {
    ...snapshotStructured,
    photo: { hasClientConsent: false, isBlurred: true },
  };
}
