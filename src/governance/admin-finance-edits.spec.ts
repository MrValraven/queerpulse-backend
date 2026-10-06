import { BadRequestException } from '@nestjs/common';
import {
  applyLedgerEdits,
  replacePartners,
  replaceReserve,
  replaceStats,
} from './admin-finance-edits';
import {
  FinanceLine,
  FinanceMetricSource,
} from './entities/governance-finance-report.entity';

function line(label: string, amount: string): FinanceLine {
  return {
    label,
    amount,
    note: '',
    width: 50,
    items: [],
    total: { label: '', amount },
  };
}

describe('admin finance edits (PRD-447)', () => {
  describe('applyLedgerEdits', () => {
    it('renames a row and audits the old and new label', () => {
      const result = applyLedgerEdits(
        'income',
        [line('Member contributions', '1840')],
        [{ index: 0, label: 'Sustainer contributions' }],
      );

      expect(result.value[0]!.label).toBe('Sustainer contributions');
      expect(result.audit).toEqual([
        {
          field: 'income[0].label',
          oldValue: 'Member contributions',
          newValue: 'Sustainer contributions',
        },
      ]);
      expect(result.isChanged).toBe(true);
      // A label is words, so the public "figures entered on" date stays put.
      expect(result.isFigureChanged).toBe(false);
    });

    it('counts a corrected amount as a figure change', () => {
      const result = applyLedgerEdits(
        'income',
        [line('Member contributions', '1840')],
        [{ index: 0, amount: '2100' }],
      );

      expect(result.isChanged).toBe(true);
      expect(result.isFigureChanged).toBe(true);
    });

    it('appends a row at the next index, sized against the largest amount', () => {
      const result = applyLedgerEdits(
        'expense',
        [line('Hosting', '400')],
        [{ index: 1, label: 'Moderator honoraria', amount: '200' }],
      );

      expect(result.value).toHaveLength(2);
      expect(result.value[1]).toMatchObject({
        label: 'Moderator honoraria',
        amount: '200',
        width: 50,
        source: FinanceMetricSource.Manual,
        enabled: true,
      });
      expect(result.isFigureChanged).toBe(true);
    });

    it('refuses an index past the next free one', () => {
      expect(() =>
        applyLedgerEdits(
          'expense',
          [line('Hosting', '400')],
          [{ index: 3, label: 'Gap', amount: '10' }],
        ),
      ).toThrow(BadRequestException);
    });

    it('refuses a new row with no amount', () => {
      expect(() =>
        applyLedgerEdits(
          'income',
          [],
          [{ index: 0, label: 'Member contributions' }],
        ),
      ).toThrow(/label and an amount/);
    });

    it('changes nothing when no edit is sent', () => {
      const lines = [line('Hosting', '400')];
      const result = applyLedgerEdits('expense', lines, undefined);

      expect(result.value).toBe(lines);
      expect(result.isChanged).toBe(false);
    });
  });

  describe('section replacements', () => {
    it('stores a partner with the admin’s own restriction words', () => {
      const result = replacePartners(null, [
        {
          name: 'A local foundation',
          amount: 400,
          scope: 'the wellbeing fund',
        },
      ]);

      expect(result.value).toEqual([
        {
          name: 'A local foundation',
          amount: 400,
          scope: 'the wellbeing fund',
          source: FinanceMetricSource.Manual,
        },
      ]);
      expect(result.audit[0]!.field).toBe('partners');
      expect(result.isFigureChanged).toBe(false);
    });

    const keyedPartner = {
      name: 'A named foundation',
      amount: 400,
      scopeKey: 'governance:sections.finances.partnerScope.mentalHealthFund',
    };

    it('keeps the translated scopeKey of a partner whose restriction the admin left alone', () => {
      const result = replacePartners(
        [keyedPartner],
        [
          {
            name: 'A named foundation',
            amount: 450,
            scopeKey: keyedPartner.scopeKey,
          },
        ],
      );

      expect(result.value).toEqual([
        {
          name: 'A named foundation',
          amount: 450,
          scopeKey: keyedPartner.scopeKey,
          source: FinanceMetricSource.Manual,
        },
      ]);
    });

    it('drops the key and stores the typed words when the admin edited the restriction', () => {
      const result = replacePartners(
        [keyedPartner],
        [
          {
            name: 'A named foundation',
            amount: 400,
            scope: 'the wellbeing fund',
          },
        ],
      );

      expect(result.value).toEqual([
        {
          name: 'A named foundation',
          amount: 400,
          scope: 'the wellbeing fund',
          source: FinanceMetricSource.Manual,
        },
      ]);
    });

    it('refuses a scopeKey the stored list does not carry', () => {
      expect(() =>
        replacePartners(
          [keyedPartner],
          [
            {
              name: 'A named foundation',
              amount: 400,
              scopeKey: 'governance:sections.finances.partnerScope.madeUp',
            },
          ],
        ),
      ).toThrow(BadRequestException);
    });

    it('strips markup from a stat tile before it reaches the public page', () => {
      const result = replaceStats(
        [],
        [{ n: '<b>€4,150</b>', l: 'Total expenditure', trend: '', up: false }],
      );

      expect(result.value[0]!.n).toBe('€4,150');
    });

    it('writes no audit row when the submitted section equals the stored one', () => {
      const reserve = { current: 100, target: 1000 };
      const result = replaceReserve(reserve, { ...reserve });

      expect(result.isChanged).toBe(false);
      expect(result.audit).toEqual([]);
    });

    it('clears the reserve when null is sent', () => {
      const result = replaceReserve({ current: 100, target: 1000 }, null);

      expect(result.value).toBeNull();
      expect(result.isChanged).toBe(true);
    });
  });
});
