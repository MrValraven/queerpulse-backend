import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazinePayment } from './entities/magazine-payment.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';

/** What one issue cost in a single currency. Every figure is a decimal string. */
export interface IssueCostCurrencyTotal {
  /** ISO 4217, e.g. "EUR". */
  currency: string;
  /** Payment rows carrying at least one amount in this currency. */
  paymentCount: number;
  /** Agreed writer fees. */
  fees: string;
  /** Reimbursed expenses. */
  expenses: string;
  /** `fees` + `expenses`. */
  total: string;
  /** The share of `total` on rows already marked paid. */
  paid: string;
  /** `total` - `paid`: what the desk still owes on this issue. */
  outstanding: string;
}

/** `GET /magazine/admin/issues/:number/costs`. */
export interface IssueCostsResponse {
  number: string;
  title: string;
  /** Pieces assigned to this issue, priced or not. */
  pieceCount: number;
  /** Payment rows opened against those pieces. */
  paymentCount: number;
  /**
   * Payment rows with no amount on either field. They are the reason a total
   * can understate the issue, so the desk sees the count beside the money
   * rather than a number that quietly excludes them.
   */
  unpricedCount: number;
  /**
   * One entry per currency actually used, ascending by code. Empty when
   * nothing on the issue is priced yet. Currencies are never summed into one
   * figure: this module holds no exchange rates and inventing one would make
   * the roll-up lie.
   */
  totals: IssueCostCurrencyTotal[];
}

interface CurrencyTotalRow {
  currency: string;
  paymentCount: number;
  fees: string;
  expenses: string;
  total: string;
  paid: string;
  outstanding: string;
}

interface IssueCounts {
  pieceCount: number;
  paymentCount: number;
  unpricedCount: number;
}

/**
 * "What did issue 09 cost" (CON-18) — the roll-up the desk could not answer
 * while every money field was `varchar`.
 *
 * Both figures are summed IN POSTGRES over `numeric`, so no JS float ever
 * touches an amount, and the result is cast back to `numeric(14,2)::text` so
 * a currency with nothing spent reads "0.00" like every other row.
 *
 * Two queries regardless of issue size: one grouped sum, one set of counts.
 * `magazine_payment` has no foreign key to `magazine_piece` (module idiom,
 * see `AddMagazinePieceRecord`), so the join is written by hand on
 * `piece_id`.
 */
@Injectable()
export class MagazineIssueCostsService {
  constructor(
    @InjectRepository(MagazineIssue)
    private readonly issues: Repository<MagazineIssue>,
    @InjectRepository(MagazinePayment)
    private readonly payments: Repository<MagazinePayment>,
    @InjectRepository(MagazinePiece)
    private readonly pieces: Repository<MagazinePiece>,
  ) {}

  async getIssueCosts(issueNumber: string): Promise<IssueCostsResponse> {
    // Staff-only surface, so this read is deliberately NOT embargo-gated the
    // way the public issue reads are: costing an issue before it ships is the
    // whole point of the tab.
    const issue = await this.issues.findOne({
      where: { number: issueNumber },
      select: { id: true, number: true, title: true },
    });
    if (!issue) {
      throw new NotFoundException('Issue not found');
    }

    const [totals, counts] = await Promise.all([
      this.currencyTotals(issue.id),
      this.counts(issue.id),
    ]);

    return {
      number: issue.number,
      title: issue.title,
      pieceCount: counts.pieceCount,
      paymentCount: counts.paymentCount,
      unpricedCount: counts.unpricedCount,
      totals,
    };
  }

  private async currencyTotals(
    issueId: string,
  ): Promise<IssueCostCurrencyTotal[]> {
    // `COALESCE(..., 0)` inside the sum, not around it: a row that priced a
    // fee but filed no expenses still contributes its fee to `total`.
    const lineTotal =
      'COALESCE(payment.fee_amount, 0) + COALESCE(payment.expenses_amount, 0)';
    const rows = await this.payments
      .createQueryBuilder('payment')
      .innerJoin(MagazinePiece, 'piece', 'piece.id = payment.piece_id')
      .select('payment.currency', 'currency')
      .addSelect('COUNT(*)::int', 'paymentCount')
      .addSelect(
        'COALESCE(SUM(payment.fee_amount), 0)::numeric(14,2)::text',
        'fees',
      )
      .addSelect(
        'COALESCE(SUM(payment.expenses_amount), 0)::numeric(14,2)::text',
        'expenses',
      )
      .addSelect(`SUM(${lineTotal})::numeric(14,2)::text`, 'total')
      .addSelect(
        `SUM(CASE WHEN payment.status = 'paid' THEN ${lineTotal} ELSE 0 END)::numeric(14,2)::text`,
        'paid',
      )
      .addSelect(
        `SUM(CASE WHEN payment.status <> 'paid' THEN ${lineTotal} ELSE 0 END)::numeric(14,2)::text`,
        'outstanding',
      )
      .where('piece.issue_id = :issueId', { issueId })
      // Unpriced rows are counted separately and kept out of the sums, so a
      // currency only appears here once something in it is actually priced.
      .andWhere(
        '(payment.fee_amount IS NOT NULL OR payment.expenses_amount IS NOT NULL)',
      )
      .groupBy('payment.currency')
      .orderBy('payment.currency', 'ASC')
      .getRawMany<CurrencyTotalRow>();

    return rows.map((row) => ({
      currency: row.currency,
      paymentCount: row.paymentCount,
      fees: row.fees,
      expenses: row.expenses,
      total: row.total,
      paid: row.paid,
      outstanding: row.outstanding,
    }));
  }

  private async counts(issueId: string): Promise<IssueCounts> {
    // Rebuilt per call rather than shared: a query builder is mutable, and
    // the unpriced count adds predicates the plain payment count must not see.
    const paymentsOnIssue = () =>
      this.payments
        .createQueryBuilder('payment')
        .innerJoin(MagazinePiece, 'piece', 'piece.id = payment.piece_id')
        .where('piece.issue_id = :issueId', { issueId });

    const [pieceCount, paymentCount, unpricedCount] = await Promise.all([
      this.pieces.countBy({ issueId }),
      paymentsOnIssue().getCount(),
      paymentsOnIssue()
        .andWhere('payment.fee_amount IS NULL')
        .andWhere('payment.expenses_amount IS NULL')
        .getCount(),
    ]);

    return { pieceCount, paymentCount, unpricedCount };
  }
}
