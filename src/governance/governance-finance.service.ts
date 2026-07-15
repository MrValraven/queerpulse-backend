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
    const report = quarter
      ? await this.reports.findOne({ where: { quarter } })
      : await this.reports.findOne({ order: { publishedAt: 'DESC' } });

    if (!report) {
      throw new NotFoundException('Governance finance report not found');
    }
    return toGovernanceFinanceResponse(report);
  }
}
