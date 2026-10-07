import {
  emptyListingOnlineDetails,
  hasOnlineFulfilmentOrSessionFormat,
  listingSellsOnline,
  normalizeListingOnlineDetails,
  normalizeOnlineListingUrl,
  toListingOnlineSummary,
  toListingPublicOnlineDetails,
} from './listing-online-details';

describe('normalizeOnlineListingUrl', () => {
  it('prefixes https:// on a bare domain', () => {
    expect(normalizeOnlineListingUrl('fiorosa.pt')).toBe('https://fiorosa.pt');
    expect(normalizeOnlineListingUrl('  fiorosa.pt/loja ')).toBe(
      'https://fiorosa.pt/loja',
    );
  });

  it('keeps an http or https link as typed', () => {
    expect(normalizeOnlineListingUrl('http://old.example.pt/a')).toBe(
      'http://old.example.pt/a',
    );
    expect(normalizeOnlineListingUrl('HTTPS://Shop.Example.PT')).toBe(
      'HTTPS://Shop.Example.PT',
    );
  });

  it('reads a host with a port as a domain', () => {
    expect(normalizeOnlineListingUrl('shop.example.pt:8080/a')).toBe(
      'https://shop.example.pt:8080/a',
    );
  });

  it('refuses every other scheme', () => {
    for (const unsafeUrl of [
      'javascript:alert(1)',
      'mailto:ola@fiorosa.pt',
      'ftp://fiorosa.pt',
      'data:text/html,hi',
      '//fiorosa.pt',
    ]) {
      expect(normalizeOnlineListingUrl(unsafeUrl)).toBeNull();
    }
  });

  it('refuses a host with no dot, credentials in the URL, and empty or overlong input', () => {
    expect(normalizeOnlineListingUrl('localhost')).toBeNull();
    expect(
      normalizeOnlineListingUrl('https://fiorosa.pt@evil.example'),
    ).toBeNull();
    expect(normalizeOnlineListingUrl('')).toBeNull();
    expect(normalizeOnlineListingUrl(`${'a'.repeat(298)}.pt`)).toBeNull();
    expect(normalizeOnlineListingUrl(42)).toBeNull();
  });

  it('refuses a newline, a tab or a backslash inside the link', () => {
    for (const disguisedUrl of [
      'etsy.com\n.evil.pt',
      'https://etsy.com\n.evil.pt',
      'etsy.com\t.evil.pt',
      'etsy.com\\@evil.pt',
      'https://etsy.com\\@evil.pt',
      'etsy.com/a b',
    ]) {
      expect(normalizeOnlineListingUrl(disguisedUrl)).toBeNull();
    }
  });

  it('reads the stored link of a long typed domain back unchanged, up to 300 characters as typed', () => {
    const typedUrl = `${'a'.repeat(296)}.pt`;
    expect(normalizeOnlineListingUrl(normalizeOnlineListingUrl(typedUrl))).toBe(
      normalizeOnlineListingUrl(typedUrl),
    );

    const longestTypedUrl = `${'a'.repeat(297)}.pt`;
    const storedUrl = normalizeOnlineListingUrl(longestTypedUrl);
    expect(storedUrl).toBe(`https://${longestTypedUrl}`);
    expect(normalizeOnlineListingUrl(storedUrl)).toBe(storedUrl);
    expect(normalizeOnlineListingUrl(`http://${longestTypedUrl}`)).toBe(
      `http://${longestTypedUrl}`,
    );
    expect(normalizeOnlineListingUrl(`https://a${longestTypedUrl}`)).toBeNull();
  });
});

describe('normalizeListingOnlineDetails', () => {
  it('reads a missing or empty value as the complete empty value', () => {
    expect(normalizeListingOnlineDetails(undefined)).toEqual(
      emptyListingOnlineDetails(),
    );
    expect(normalizeListingOnlineDetails({})).toEqual(
      emptyListingOnlineDetails(),
    );
    expect(normalizeListingOnlineDetails('nonsense')).toEqual(
      emptyListingOnlineDetails(),
    );
  });

  it('keeps known values once each, in canonical order', () => {
    const details = normalizeListingOnlineDetails({
      fulfilment: ['pickupLisbon', 'shipsEu', 'shipsEu', 'teleport'],
      payments: ['paypal', 'mbway'],
      sessionFormats: ['phone', 'video'],
    });

    expect(details.fulfilment).toEqual(['shipsEu', 'pickupLisbon']);
    expect(details.payments).toEqual(['mbway', 'paypal']);
    expect(details.sessionFormats).toEqual(['video', 'phone']);
  });

  it('stores the main link with https and drops one with an unknown kind', () => {
    expect(
      normalizeListingOnlineDetails({
        mainLink: { url: 'fiorosa.pt', kind: 'shop' },
      }).mainLink,
    ).toEqual({ url: 'https://fiorosa.pt', kind: 'shop' });
    expect(
      normalizeListingOnlineDetails({
        mainLink: { url: 'fiorosa.pt', kind: 'shopfront' },
      }).mainLink,
    ).toBeNull();
  });

  it('keeps at most four valid more links', () => {
    const moreLinks = Array.from({ length: 6 }, (_unused, index) => ({
      url: `shop${index}.example.pt`,
      platform: 'etsy',
    }));
    const details = normalizeListingOnlineDetails({
      moreLinks: [
        { url: 'javascript:alert(1)', platform: 'etsy' },
        ...moreLinks,
      ],
    });

    expect(details.moreLinks).toHaveLength(4);
    expect(details.moreLinks[0]).toEqual({
      url: 'https://shop0.example.pt',
      platform: 'etsy',
    });
  });

  it('includes VAT only for shipping from outside the EU', () => {
    expect(
      normalizeListingOnlineDetails({ shipsFrom: 'eu', isVatIncluded: true })
        .isVatIncluded,
    ).toBe(false);
    expect(
      normalizeListingOnlineDetails({
        shipsFrom: 'outsideEu',
        isVatIncluded: true,
      }).isVatIncluded,
    ).toBe(true);
  });

  it('blanks a registration number that names no body', () => {
    expect(
      normalizeListingOnlineDetails({
        registration: { body: '', number: '12345' },
      }).registration,
    ).toEqual({ body: '', number: '' });
    expect(
      normalizeListingOnlineDetails({
        registration: { body: 'opp', number: ' 12345 ' },
      }).registration,
    ).toEqual({ body: 'opp', number: '12345' });
  });

  it('trims the notes and cuts them at 140 characters', () => {
    const details = normalizeListingOnlineDetails({
      replyNote: `  ${'é'.repeat(150)}  `,
      pickupNote: ' At Livraria Rosa, on Saturdays ',
    });

    expect(Array.from(details.replyNote)).toHaveLength(140);
    expect(details.pickupNote).toBe('At Livraria Rosa, on Saturdays');
  });

  it('passes a stored acceptance stamp through and reads a blank one as none', () => {
    expect(
      normalizeListingOnlineDetails({
        adultTermsAcceptedAt: '2026-10-07T10:00:00.000Z',
      }).adultTermsAcceptedAt,
    ).toBe('2026-10-07T10:00:00.000Z');
    expect(
      normalizeListingOnlineDetails({ adultTermsAcceptedAt: '' })
        .adultTermsAcceptedAt,
    ).toBeNull();
  });
});

describe('public online views', () => {
  const sellingDetails = {
    mainLink: { url: 'https://fiorosa.pt', kind: 'shop' },
    fulfilment: ['digital'],
    sessionFormats: ['video'],
    adultTermsAcceptedAt: '2026-10-07T10:00:00.000Z',
  };

  it('counts a listing as selling online when it is online or has an online shop', () => {
    expect(listingSellsOnline({ online: true })).toBe(true);
    expect(listingSellsOnline({ online: false, hasOnlineShop: true })).toBe(
      true,
    );
    expect(listingSellsOnline({ online: false, hasOnlineShop: false })).toBe(
      false,
    );
    expect(listingSellsOnline({})).toBe(false);
  });

  it('gives a listing that does not sell online no public block and no summary', () => {
    const place = { online: false, onlineDetails: sellingDetails };
    expect(toListingPublicOnlineDetails(place)).toBeNull();
    expect(toListingOnlineSummary(place)).toBeNull();
  });

  it('keeps the acceptance stamp off the public block', () => {
    const publicDetails = toListingPublicOnlineDetails({
      online: true,
      onlineDetails: sellingDetails,
    });

    expect(publicDetails).not.toHaveProperty('adultTermsAcceptedAt');
    expect(publicDetails?.mainLink).toEqual({
      url: 'https://fiorosa.pt',
      kind: 'shop',
    });
  });

  it('summarises the main link, delivery and sessions', () => {
    expect(
      toListingOnlineSummary({ online: true, onlineDetails: sellingDetails }),
    ).toEqual({
      mainLink: { url: 'https://fiorosa.pt', kind: 'shop' },
      fulfilment: ['digital'],
      sessionFormats: ['video'],
    });
  });

  it('answers the claim requirement with either a delivery option or a session format', () => {
    expect(
      hasOnlineFulfilmentOrSessionFormat({ fulfilment: ['digital'] }),
    ).toBe(true);
    expect(
      hasOnlineFulfilmentOrSessionFormat({ sessionFormats: ['phone'] }),
    ).toBe(true);
    expect(hasOnlineFulfilmentOrSessionFormat({})).toBe(false);
    expect(hasOnlineFulfilmentOrSessionFormat(undefined)).toBe(false);
  });
});
