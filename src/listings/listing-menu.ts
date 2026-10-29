import { BadRequestException } from '@nestjs/common';
import { toImageUrl } from '../common/image-url';
import { toBareKey } from '../storage/bare-key';
import { contentTypeForStorageKey } from '../storage/served-object';
import { parseStorageKey } from '../storage/storage-key';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import {
  DEFAULT_LISTING_MENU_CURRENCY,
  LISTING_MENU_DIETARY,
  LISTING_MENU_PRICE_PATTERN,
  MAX_LISTING_MENU_ITEMS,
} from './dto/create-listing.dto';
import type {
  ListingMenu,
  ListingMenuCurrency,
  ListingMenuFile,
  ListingMenuItem,
  ListingMenuSection,
  ListingMenuSubsection,
  ListingPricingMode,
} from './entities/listing.entity';

/**
 * Raw category values that default a listing to a menu: the canonical slugs
 * plus the legacy labels and venue types the frontend's `normalizeCategory`
 * heals. Same list as the `AddListingMenu1821600000000` backfill.
 */
const MENU_CATEGORY_VALUES: ReadonlySet<string> = new Set([
  'food',
  'nightlife',
  'food & drink',
  'café',
  'bar',
  'club',
  'sauna',
]);

/** A fresh empty menu. A function so no caller shares one mutable object. */
export function emptyListingMenu(): ListingMenu {
  return {
    sections: [],
    file: null,
    link: '',
    currency: DEFAULT_LISTING_MENU_CURRENCY,
  };
}

/**
 * A menu as the API answers it: the currency and every section's
 * `subsections` are always present.
 */
export type ListingMenuView = Omit<ListingMenu, 'sections'> & {
  currency: ListingMenuCurrency;
  sections: (ListingMenuSection & { subsections: ListingMenuSubsection[] })[];
};

/**
 * Stored sections with `subsections: []` added to the ones saved before
 * sub-sections, so they compare equal to the sections the owner's next save
 * sends back.
 */
export function healStoredMenuSections(
  sections: readonly ListingMenuSection[],
): (ListingMenuSection & { subsections: ListingMenuSubsection[] })[] {
  return sections.map((section) => ({
    ...section,
    subsections: section.subsections ?? [],
  }));
}

/**
 * A stored menu with the default currency and empty `subsections` added, so
 * a row saved before currencies or sub-sections compares equal to the menu
 * the owner's next save sends back. Heals a null or partial value.
 */
export function healStoredListingMenu(
  menu: Partial<ListingMenu> | null | undefined,
): ListingMenu {
  return {
    sections: healStoredMenuSections(menu?.sections ?? []),
    file: menu?.file ?? null,
    link: menu?.link ?? '',
    currency: menu?.currency ?? DEFAULT_LISTING_MENU_CURRENCY,
  };
}

export function defaultPricingModeForCats(
  cats: readonly string[],
): ListingPricingMode {
  const isMenuCategory = cats.some((category) =>
    MENU_CATEGORY_VALUES.has(category.trim().toLowerCase()),
  );
  return isMenuCategory ? 'menu' : 'services';
}

interface ListingMenuItemInput {
  name: string;
  price: string;
  description?: string;
  dietary?: readonly string[];
}

/** An item inside a sub-section: every price is optional. */
interface ListingMenuSubsectionItemInput {
  name: string;
  price?: string;
  priceGlass?: string;
  priceBottle?: string;
  description?: string;
  dietary?: readonly string[];
}

interface ListingMenuInput {
  sections?: {
    title?: string;
    items?: ListingMenuItemInput[];
    subsections?: {
      title?: string;
      items?: ListingMenuSubsectionItemInput[];
    }[];
  }[];
  file?: { url: string; fileName?: string } | null;
  link?: string;
  currency?: ListingMenuCurrency;
}

function normalizeMenuItem(
  input: ListingMenuSubsectionItemInput,
): ListingMenuItem {
  const requestedDietaryLabels = new Set(input.dietary ?? []);
  const priceGlass = (input.priceGlass ?? '').trim();
  const priceBottle = (input.priceBottle ?? '').trim();
  return {
    name: input.name.trim(),
    price: (input.price ?? '').trim(),
    // A blank glass or bottle price leaves the key out, so an item saved
    // without one stays equal to the stored item.
    ...(priceGlass ? { priceGlass } : {}),
    ...(priceBottle ? { priceBottle } : {}),
    description: (input.description ?? '').trim(),
    dietary: LISTING_MENU_DIETARY.filter((label) =>
      requestedDietaryLabels.has(label),
    ),
  };
}

function normalizeMenuFile(
  input: ListingMenuInput['file'],
): ListingMenuFile | null {
  if (!input) return null;
  const bareKey = toBareKey(input.url);
  if (parseStorageKey(bareKey) !== UPLOAD_KIND_SPECS['listing-menu']) {
    throw new BadRequestException(
      'menu.file.url must be a listing-menu upload',
    );
  }
  return {
    url: bareKey,
    contentType: contentTypeForStorageKey(bareKey) ?? '',
    fileName: (input.fileName ?? '').trim(),
  };
}

/**
 * Every trimmed item price in a stored menu (sub-section items and their glass
 * and bottle prices included), legacy free text included.
 */
function storedMenuPrices(
  storedMenu: Partial<ListingMenu> | null | undefined,
): ReadonlySet<string> {
  const storedPrices = new Set<string>();
  for (const section of storedMenu?.sections ?? []) {
    const storedItems = [
      ...(section.items ?? []),
      ...(section.subsections ?? []).flatMap(
        (subsection) => subsection.items ?? [],
      ),
    ];
    for (const item of storedItems) {
      for (const storedPrice of [
        item.price,
        item.priceGlass,
        item.priceBottle,
      ]) {
        if (storedPrice !== undefined) storedPrices.add(storedPrice.trim());
      }
    }
  }
  return storedPrices;
}

/**
 * A price is valid when it is a plain number ("3", "2.50") or is already
 * stored on this listing's menu. The second case keeps a legacy price such as
 * "market price" from blocking an unrelated save, since the client resends the
 * whole menu every time. The field path leads the message so the form can
 * place it on the field.
 */
function assertValidMenuPrice(
  price: string,
  storedPrices: ReadonlySet<string>,
  fieldPath: string,
  exampleNumber: string,
): void {
  const trimmedPrice = price.trim();
  if (
    LISTING_MENU_PRICE_PATTERN.test(trimmedPrice) ||
    storedPrices.has(trimmedPrice)
  ) {
    return;
  }
  throw new BadRequestException(
    `${fieldPath} must be a number such as ${exampleNumber}, without a currency sign or text (got "${trimmedPrice}")`,
  );
}

/**
 * The stored shape of a menu a client sent: trimmed, empty sections and
 * sub-sections dropped, dietary labels de-duplicated into display order, the
 * file checked to be a `listing-menu` upload, the currency defaulted to euros,
 * every section carrying a `subsections` array. Throws 400 on the rules the
 * DTO cannot express: more than `MAX_LISTING_MENU_ITEMS` items in total
 * (sub-section items count), a section or sub-section with items but no title,
 * and a price that is neither a plain number nor already in `storedMenu` (a
 * create passes none, so it is strict). A direct item needs a price; a
 * sub-section item may have none, and its glass and bottle prices are optional.
 */
export function normalizeListingMenu(
  input?: ListingMenuInput | null,
  storedMenu?: Partial<ListingMenu> | null,
): ListingMenu {
  if (!input) return emptyListingMenu();
  const storedPrices = storedMenuPrices(storedMenu);
  // Indices come from the client's arrays, before empty sections drop out, so
  // an error points at the row the form shows.
  const keptSections = (input.sections ?? [])
    .map((section, sectionIndex) => ({
      sectionIndex,
      title: (section.title ?? '').trim(),
      items: (section.items ?? []).map((item, itemIndex) => {
        assertValidMenuPrice(
          item.price,
          storedPrices,
          `menu.sections.${sectionIndex}.items.${itemIndex}.price`,
          '2.50',
        );
        return normalizeMenuItem(item);
      }),
      subsections: (section.subsections ?? [])
        .map((subsection, subsectionIndex) => ({
          subsectionIndex,
          title: (subsection.title ?? '').trim(),
          items: (subsection.items ?? []).map((item, itemIndex) => {
            const itemPath = `menu.sections.${sectionIndex}.subsections.${subsectionIndex}.items.${itemIndex}`;
            const optionalPrices = [
              ['price', item.price, '2.50'],
              ['priceGlass', item.priceGlass, '12.50'],
              ['priceBottle', item.priceBottle, '48.00'],
            ] as const;
            for (const [
              fieldName,
              fieldValue,
              exampleNumber,
            ] of optionalPrices) {
              if ((fieldValue ?? '').trim() !== '') {
                assertValidMenuPrice(
                  fieldValue ?? '',
                  storedPrices,
                  `${itemPath}.${fieldName}`,
                  exampleNumber,
                );
              }
            }
            return normalizeMenuItem(item);
          }),
        }))
        .filter((subsection) => subsection.items.length > 0),
    }))
    .filter(
      (section) => section.items.length > 0 || section.subsections.length > 0,
    );
  const itemCount = keptSections.reduce(
    (total, section) =>
      total +
      section.items.length +
      section.subsections.reduce(
        (subtotal, subsection) => subtotal + subsection.items.length,
        0,
      ),
    0,
  );
  if (itemCount > MAX_LISTING_MENU_ITEMS) {
    throw new BadRequestException(
      `menu can hold at most ${MAX_LISTING_MENU_ITEMS} items`,
    );
  }
  for (const section of keptSections) {
    if (section.title === '') {
      throw new BadRequestException(
        `menu.sections.${section.sectionIndex}.title: a menu section with items or sub-sections needs a title`,
      );
    }
    for (const subsection of section.subsections) {
      if (subsection.title === '') {
        throw new BadRequestException(
          `menu.sections.${section.sectionIndex}.subsections.${subsection.subsectionIndex}.title: a sub-section with items needs a title`,
        );
      }
    }
  }
  return {
    sections: keptSections.map((section) => ({
      title: section.title,
      items: section.items,
      subsections: section.subsections.map((subsection) => ({
        title: subsection.title,
        items: subsection.items,
      })),
    })),
    file: normalizeMenuFile(input.file),
    link: (input.link ?? '').trim(),
    currency: input.currency ?? DEFAULT_LISTING_MENU_CURRENCY,
  };
}

/**
 * The response shape: the full menu with the file key resolved to its
 * served URL. Heals a null or partial stored value, and drops a file whose
 * key no longer resolves, and answers EUR for a menu saved before currencies.
 */
export function toListingMenuView(
  menu: Partial<ListingMenu> | null | undefined,
): ListingMenuView {
  const file = menu?.file ?? null;
  const fileUrl = file ? toImageUrl(file.url) : null;
  return {
    sections: healStoredMenuSections(menu?.sections ?? []),
    file: file && fileUrl ? { ...file, url: fileUrl } : null,
    link: menu?.link ?? '',
    currency: menu?.currency ?? DEFAULT_LISTING_MENU_CURRENCY,
  };
}
