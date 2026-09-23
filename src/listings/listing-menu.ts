import { BadRequestException } from '@nestjs/common';
import { toImageUrl } from '../common/image-url';
import { toBareKey } from '../storage/bare-key';
import { contentTypeForStorageKey } from '../storage/served-object';
import { parseStorageKey } from '../storage/storage-key';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import {
  LISTING_MENU_DIETARY,
  MAX_LISTING_MENU_ITEMS,
} from './dto/create-listing.dto';
import type {
  ListingMenu,
  ListingMenuFile,
  ListingMenuItem,
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
  return { sections: [], file: null, link: '' };
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

interface ListingMenuInput {
  sections?: { title?: string; items?: ListingMenuItemInput[] }[];
  file?: { url: string; fileName?: string } | null;
  link?: string;
}

function normalizeMenuItem(input: ListingMenuItemInput): ListingMenuItem {
  const requestedDietaryLabels = new Set(input.dietary ?? []);
  return {
    name: input.name.trim(),
    price: input.price.trim(),
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
 * The stored shape of a menu a client sent: trimmed, empty sections dropped,
 * dietary labels de-duplicated into display order, the file checked to be a
 * `listing-menu` upload. Throws 400 on the two rules the DTO cannot express:
 * more than `MAX_LISTING_MENU_ITEMS` items in total, and a section with items
 * but no title.
 */
export function normalizeListingMenu(
  input?: ListingMenuInput | null,
): ListingMenu {
  if (!input) return emptyListingMenu();
  const sections = (input.sections ?? [])
    .map((section) => ({
      title: (section.title ?? '').trim(),
      items: (section.items ?? []).map(normalizeMenuItem),
    }))
    .filter((section) => section.items.length > 0);
  const itemCount = sections.reduce(
    (total, section) => total + section.items.length,
    0,
  );
  if (itemCount > MAX_LISTING_MENU_ITEMS) {
    throw new BadRequestException(
      `menu can hold at most ${MAX_LISTING_MENU_ITEMS} items`,
    );
  }
  if (sections.some((section) => section.title === '')) {
    throw new BadRequestException(
      'every menu section with items needs a title',
    );
  }
  return {
    sections,
    file: normalizeMenuFile(input.file),
    link: (input.link ?? '').trim(),
  };
}

/**
 * The response shape: the full menu with the file key resolved to its
 * served URL. Heals a null or partial stored value, and drops a file whose
 * key no longer resolves.
 */
export function toListingMenuView(
  menu: Partial<ListingMenu> | null | undefined,
): ListingMenu {
  const file = menu?.file ?? null;
  const fileUrl = file ? toImageUrl(file.url) : null;
  return {
    sections: menu?.sections ?? [],
    file: file && fileUrl ? { ...file, url: fileUrl } : null,
    link: menu?.link ?? '',
  };
}
