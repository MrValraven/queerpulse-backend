import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dropStudioMoneyRequestBody,
  isStudioMoneyRequestUrl,
} from './studio-purchase-request-log';

const personaId = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const purchaseId = '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f';

describe('dropStudioMoneyRequestBody', () => {
  it.each([
    `/studio/artists/${personaId}/payment-methods`,
    '/v1/studio/purchases/',
    `/studio/purchases/${purchaseId}/wall`,
    `/studio/artists/${personaId}/purchases/${purchaseId}/decline`,
    `https://api.queerpulse.test/studio/purchases?x=1`,
  ])('drops the body for every money route and any method: %s', (url) => {
    const request = {
      url,
      data: { methods: [{ kind: 'iban', value: 'PT50000201231234567890154' }] },
    };
    dropStudioMoneyRequestBody(request);
    expect(request).toEqual({ url });
  });

  it.each([
    '/studio/purchasesx',
    `/studio/purchases/${purchaseId}/cancel`,
    '/communities/x/giving',
    undefined,
    '',
  ])('keeps the body of %s', (url) => {
    const request = { url, data: { note: 'kept' } };
    dropStudioMoneyRequestBody(request);
    expect(request).toEqual({ url, data: { note: 'kept' } });
  });

  it('accepts an event with no request', () => {
    expect(() => dropStudioMoneyRequestBody(undefined)).not.toThrow();
  });
});

describe('isStudioMoneyRequestUrl', () => {
  it('answers true for the four money routes and false for an absent url', () => {
    expect(isStudioMoneyRequestUrl('/studio/purchases')).toBe(true);
    expect(isStudioMoneyRequestUrl(undefined)).toBe(false);
  });
});

it('imports nothing', () => {
  expect(
    readFileSync(join(__dirname, 'studio-purchase-request-log.ts'), 'utf8'),
  ).not.toMatch(/^import /m);
});
