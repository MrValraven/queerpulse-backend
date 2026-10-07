import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListingOnlineDetailsDto,
  ListingOnlineMainLinkDto,
  ListingShopItemDto,
} from './listing-online-details.dto';

async function errorCount<Target extends object>(
  dtoClass: new () => Target,
  body: Record<string, unknown>,
): Promise<number> {
  return (await validate(plainToInstance(dtoClass, body))).length;
}

describe('ListingOnlineMainLinkDto', () => {
  it('accepts a bare domain with a known kind', async () => {
    expect(
      await errorCount(ListingOnlineMainLinkDto, {
        url: 'fiorosa.pt',
        kind: 'shop',
      }),
    ).toBe(0);
  });

  it('refuses an unknown kind, an empty url and a javascript: url', async () => {
    expect(
      await errorCount(ListingOnlineMainLinkDto, {
        url: 'fiorosa.pt',
        kind: 'shopfront',
      }),
    ).toBeGreaterThan(0);
    expect(
      await errorCount(ListingOnlineMainLinkDto, { url: '', kind: 'shop' }),
    ).toBeGreaterThan(0);
    expect(
      await errorCount(ListingOnlineMainLinkDto, {
        url: 'javascript:alert(1)',
        kind: 'shop',
      }),
    ).toBeGreaterThan(0);
  });

  it('accepts a stored link of 300 typed characters echoed back with its https://', async () => {
    const storedUrl = `https://${'a'.repeat(297)}.pt`;

    expect(
      await errorCount(ListingOnlineMainLinkDto, {
        url: storedUrl,
        kind: 'shop',
      }),
    ).toBe(0);
    expect(
      await errorCount(ListingOnlineDetailsDto, {
        mainLink: { url: storedUrl, kind: 'shop' },
        moreLinks: [{ url: storedUrl, platform: 'etsy' }],
      }),
    ).toBe(0);
    expect(
      await errorCount(ListingShopItemDto, {
        id: 'item-1',
        name: 'Zine',
        link: storedUrl,
      }),
    ).toBe(0);
  });

  it('refuses a link of 301 characters after its https://', async () => {
    expect(
      await errorCount(ListingOnlineMainLinkDto, {
        url: `https://${'a'.repeat(298)}.pt`,
        kind: 'shop',
      }),
    ).toBeGreaterThan(0);
  });

  it('refuses a url carrying a newline, a tab or a backslash', async () => {
    for (const disguisedUrl of [
      'etsy.com\n.evil.pt',
      'etsy.com\t.evil.pt',
      'etsy.com\\@evil.pt',
    ]) {
      expect(
        await errorCount(ListingOnlineMainLinkDto, {
          url: disguisedUrl,
          kind: 'shop',
        }),
      ).toBeGreaterThan(0);
    }
  });
});

describe('ListingOnlineDetailsDto', () => {
  const completeDetails = {
    mainLink: { url: 'https://fiorosa.pt', kind: 'shop' },
    moreLinks: [{ url: 'etsy.com/shop/fiorosa', platform: 'etsy' }],
    fulfilment: ['shipsPortugal', 'shipsEu'],
    pickupNote: '',
    shipsFrom: 'outsideEu',
    isVatIncluded: true,
    payments: ['mbway', 'card'],
    sessionFormats: [],
    registration: { body: '', number: '' },
    replyNote: 'Orders packed Tuesdays and Fridays.',
    adultTermsAcceptedAt: '2026-10-07T10:00:00.000Z',
  };

  it('accepts a complete value, an echoed acceptance stamp included', async () => {
    expect(await errorCount(ListingOnlineDetailsDto, completeDetails)).toBe(0);
    expect(
      await errorCount(ListingOnlineDetailsDto, {
        ...completeDetails,
        mainLink: null,
        adultTermsAcceptedAt: null,
      }),
    ).toBe(0);
  });

  it('accepts an empty value, every key being optional on input', async () => {
    expect(await errorCount(ListingOnlineDetailsDto, {})).toBe(0);
  });

  it('refuses a fifth more link, an unknown option and an unknown platform', async () => {
    const link = { url: 'fiorosa.pt', platform: 'etsy' };
    expect(
      await errorCount(ListingOnlineDetailsDto, {
        moreLinks: [link, link, link, link, link],
      }),
    ).toBeGreaterThan(0);
    expect(
      await errorCount(ListingOnlineDetailsDto, { fulfilment: ['teleport'] }),
    ).toBeGreaterThan(0);
    expect(
      await errorCount(ListingOnlineDetailsDto, {
        moreLinks: [{ url: 'fiorosa.pt', platform: 'myspace' }],
      }),
    ).toBeGreaterThan(0);
  });

  it('refuses notes over 140 characters and a registration number over 40', async () => {
    expect(
      await errorCount(ListingOnlineDetailsDto, { replyNote: 'x'.repeat(141) }),
    ).toBeGreaterThan(0);
    expect(
      await errorCount(ListingOnlineDetailsDto, {
        registration: { body: 'opp', number: '1'.repeat(41) },
      }),
    ).toBeGreaterThan(0);
  });

  it('accepts an unanswered ships-from and refuses an unknown one', async () => {
    expect(await errorCount(ListingOnlineDetailsDto, { shipsFrom: '' })).toBe(
      0,
    );
    expect(
      await errorCount(ListingOnlineDetailsDto, { shipsFrom: 'mars' }),
    ).toBeGreaterThan(0);
  });
});

describe('ListingShopItemDto', () => {
  it('accepts an item with only an id and a name', async () => {
    expect(
      await errorCount(ListingShopItemDto, { id: 'item-1', name: 'Zine' }),
    ).toBe(0);
  });

  it('accepts a photo shaped like a gallery photo and an empty link', async () => {
    expect(
      await errorCount(ListingShopItemDto, {
        id: 'item-1',
        name: 'Mug',
        price: '18 EUR',
        link: '',
        photo: {
          image: 'https://images.unsplash.com/photo-mug.jpg',
          alt: 'A blue mug',
        },
      }),
    ).toBe(0);
  });

  it('refuses an empty or blank id', async () => {
    expect(
      await errorCount(ListingShopItemDto, { id: '', name: 'Zine' }),
    ).toBeGreaterThan(0);
    expect(
      await errorCount(ListingShopItemDto, { id: '   ', name: 'Zine' }),
    ).toBeGreaterThan(0);
  });

  it('refuses a blank name, a 61-character name and a 21-character price', async () => {
    expect(
      await errorCount(ListingShopItemDto, { id: 'item-1', name: '   ' }),
    ).toBeGreaterThan(0);
    expect(
      await errorCount(ListingShopItemDto, {
        id: 'item-1',
        name: 'x'.repeat(61),
      }),
    ).toBeGreaterThan(0);
    expect(
      await errorCount(ListingShopItemDto, {
        id: 'item-1',
        name: 'Mug',
        price: '1'.repeat(21),
      }),
    ).toBeGreaterThan(0);
  });

  it('refuses a non-web link and a photo with no alt text', async () => {
    expect(
      await errorCount(ListingShopItemDto, {
        id: 'item-1',
        name: 'Mug',
        link: 'ftp://fiorosa.pt',
      }),
    ).toBeGreaterThan(0);
    expect(
      await errorCount(ListingShopItemDto, {
        id: 'item-1',
        name: 'Mug',
        photo: { image: 'https://images.unsplash.com/photo-mug.jpg' },
      }),
    ).toBeGreaterThan(0);
  });
});
