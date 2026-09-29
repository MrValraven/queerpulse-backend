import { splitCommissionFee } from './magazine-money';

describe('splitCommissionFee', () => {
  it.each([
    ['150', '150'],
    ['€150', '150'],
    ['150 €', '150'],
    ['150,50', '150.50'],
    ['EUR 1200.5', '1200.5'],
  ])('reads %p as the amount %p', (rawFee, expectedAmount) => {
    expect(splitCommissionFee(rawFee)).toEqual({
      feeAmount: expectedAmount,
      feeText: null,
    });
  });

  it('keeps wording that is more than an amount as text', () => {
    expect(splitCommissionFee('150 plus travel')).toEqual({
      feeAmount: null,
      feeText: '150 plus travel',
    });
  });

  it('clears both fields for an empty fee', () => {
    expect(splitCommissionFee('')).toEqual({ feeAmount: null, feeText: null });
    expect(splitCommissionFee('   ')).toEqual({
      feeAmount: null,
      feeText: null,
    });
  });

  it('keeps a bare currency mark as text', () => {
    expect(splitCommissionFee('€')).toEqual({ feeAmount: null, feeText: '€' });
  });

  it('caps a long text fee at 200 characters', () => {
    const result = splitCommissionFee(`Flat fee ${'x'.repeat(300)}`);

    expect(result.feeAmount).toBeNull();
    expect(result.feeText).toHaveLength(200);
  });
});
