import {
  MAX_LISTING_SHOP_ITEMS,
  normalizeListingShopItems,
  shopItemImageReferences,
  toListingShopItemViews,
} from './listing-shop-items';

const MUG_PHOTO_URL = 'https://images.unsplash.com/photo-mug.jpg';

describe('normalizeListingShopItems', () => {
  it('trims, fills every key and stores the link with https', () => {
    expect(
      normalizeListingShopItems([
        {
          id: ' item-1 ',
          name: '  Ceramic mug ',
          price: ' 18 EUR ',
          link: 'fiorosa.pt/mug',
        },
      ]),
    ).toEqual([
      {
        id: 'item-1',
        name: 'Ceramic mug',
        price: '18 EUR',
        link: 'https://fiorosa.pt/mug',
        photo: null,
      },
    ]);
  });

  it('drops an item with no id or no name, and a repeated id', () => {
    expect(
      normalizeListingShopItems([
        { id: '', name: 'No id' },
        { id: 'item-1', name: '   ' },
        { id: 'item-2', name: 'Zine' },
        { id: 'item-2', name: 'Zine again' },
      ]).map((item) => item.name),
    ).toEqual(['Zine']);
  });

  it('reads a stored 300-character link back unchanged and a link with a newline as no link', () => {
    const typedLink = `${'a'.repeat(297)}.pt`;
    const [storedItem] = normalizeListingShopItems([
      { id: 'item-1', name: 'Zine', link: typedLink },
    ]);

    expect(storedItem?.link).toBe(`https://${typedLink}`);
    expect(normalizeListingShopItems([storedItem])[0]?.link).toBe(
      `https://${typedLink}`,
    );
    expect(
      normalizeListingShopItems([
        { id: 'item-1', name: 'Zine', link: 'etsy.com\n.evil.pt' },
      ])[0]?.link,
    ).toBe('');
  });

  it('keeps at most six items', () => {
    const items = Array.from({ length: 8 }, (_unused, index) => ({
      id: `item-${index}`,
      name: `Item ${index}`,
    }));
    expect(normalizeListingShopItems(items)).toHaveLength(
      MAX_LISTING_SHOP_ITEMS,
    );
  });

  it('reads an unusable link as no link and a photo with no image as no photo', () => {
    const [item] = normalizeListingShopItems([
      {
        id: 'item-1',
        name: 'Zine',
        link: 'javascript:alert(1)',
        photo: { image: '', alt: 'Nothing' },
      },
    ]);
    expect(item?.link).toBe('');
    expect(item?.photo).toBeNull();
  });

  it('reads a missing column as no items', () => {
    expect(normalizeListingShopItems(undefined)).toEqual([]);
    expect(normalizeListingShopItems({})).toEqual([]);
  });
});

describe('shop item photos', () => {
  const items = [
    {
      id: 'item-1',
      name: 'Ceramic mug',
      price: '18 EUR',
      link: '',
      photo: { image: MUG_PHOTO_URL, alt: 'A blue mug', caption: '' },
    },
    { id: 'item-2', name: 'Gift card', price: '', link: '', photo: null },
  ];

  it('lists the image reference of every item that has a photo', () => {
    expect(shopItemImageReferences(items)).toEqual([MUG_PHOTO_URL]);
  });

  it('resolves each photo the way the gallery does, crop and alt included', () => {
    const crop = { x: 0.1, y: 0, width: 0.8, height: 1, aspect: '1:1' };
    const views = toListingShopItemViews(
      items,
      new Map([[MUG_PHOTO_URL, crop]]),
    );

    expect(views[0]?.photo).toEqual({
      image: MUG_PHOTO_URL,
      alt: 'A blue mug',
      caption: '',
      crop,
    });
    expect(views[1]?.photo).toBeNull();
  });
});
