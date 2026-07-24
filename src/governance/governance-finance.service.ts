import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  GovernanceFinanceResponseDTO,
  toGovernanceFinanceResponse,
} from './governance-finance-response';
import { GovernanceFinanceReport } from './entities/governance-finance-report.entity';

@Injectable()
export class GovernanceFinanceService {
  constructor(
    @InjectRepository(GovernanceFinanceReport)
    private readonly reports: Repository<GovernanceFinanceReport>,
  ) {}

  // A specific `quarter` fetches that snapshot exactly; omitted fetches the
  // most recently published one (the "Q2 2026 · Financial transparency"
  // section always shows the latest quarter by default).
  async getFinances(quarter?: string): Promise<GovernanceFinanceResponseDTO> {
    // A specific `quarter` is a keyed lookup (`findOne` with a `where`). The
    // "latest" path has no selection conditions, so it must NOT use `findOne` —
    // TypeORM throws "You must provide selection conditions in order to find a
    // single row" when `findOne` is called without a `where`. Take the newest
    // row via `find` with `take: 1` instead.
    let report: GovernanceFinanceReport | null;
    if (quarter) {
      report = await this.reports.findOne({ where: { quarter } });
    } else {
      const [latest] = await this.reports.find({
        order: { publishedAt: 'DESC' },
        take: 1,
      });
      report = latest ?? null;
    }

    if (!report) {
      throw new NotFoundException('Governance finance report not found');
    }
    return toGovernanceFinanceResponse(report);
  }
}
