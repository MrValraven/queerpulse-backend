import { KIND_SEARCH_TERMS } from './subprofile-kind-search';
import type { SubprofileKind } from './subprofile-kinds';

/**
 * The persona title rule, mirrored from the frontend helpers of the same names
 * in `src/features/subprofiles/personaTitleName.ts`. Change both together: the
 * frontend titles a persona on its page and in the chat inbox/header, and the
 * server titles it in quoted-message labels and push notifications, so the two
 * must agree on every name.
 *
 * The labels come from `KIND_SEARCH_TERMS`, whose entry 0 is the kind's EN
 * label and entry 1 its PT label. Later entries are extra search words ("dm"
 * for a game master) that nobody gets as a default name, so they never make a
 * name bare.
 */
const LABEL_COUNT = 2;

/** Fold a name for comparison: accents stripped, trimmed, inner whitespace
 *  collapsed and lowercased, so "  ASTROLOGIA " and "Astrologia" compare
 *  equal. Same steps, in the same order, as the frontend's
 *  `foldProfessionName`. */
function foldProfessionName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Mark}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** The kind's EN and PT labels: the first two `KIND_SEARCH_TERMS` entries. */
function kindLabels(kind: SubprofileKind): readonly string[] {
  return KIND_SEARCH_TERMS[kind].slice(0, LABEL_COUNT);
}

/**
 * Is this persona still carrying its profession as its name? A persona created
 * without a display name persists the kind's EN label, and the create form
 * suggests the translated label, so a name equal to either label (case,
 * accents and surrounding whitespace ignored) is the default rather than a
 * name anyone chose.
 */
export function isBareProfessionName({
  displayName,
  kind,
}: {
  displayName: string;
  kind: SubprofileKind;
}): boolean {
  const foldedName = foldProfessionName(displayName);
  return kindLabels(kind).some(
    (label) => foldProfessionName(label) === foldedName,
  );
}

/**
 * The name to title a persona with wherever other people see it. A persona
 * still named after its profession ("Art historian") is titled
 * "Owner Name | Art historian", with the craft always spelled as the EN label.
 * A persona with a chosen name, or with no owner name to borrow (an unlinked
 * persona deliberately carries none), keeps its display name trimmed.
 */
export function personaTitleName({
  displayName,
  kind,
  ownerName,
}: {
  displayName: string;
  kind: SubprofileKind;
  ownerName?: string | null;
}): string {
  const trimmedName = displayName.trim();
  if (!isBareProfessionName({ displayName, kind })) return trimmedName;
  const trimmedOwnerName = ownerName?.trim();
  const [englishLabel] = kindLabels(kind);
  if (!trimmedOwnerName || !englishLabel) return trimmedName;
  return `${trimmedOwnerName} | ${englishLabel}`;
}
