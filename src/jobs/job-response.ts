import { MemberRef } from '../common/member-ref';
import {
  JobApplication,
  JobApplicationStatus,
} from './entities/job-application.entity';
import {
  Job,
  JobDetailBody,
  JobFormat,
  JobStatus,
} from './entities/job.entity';

export interface JobPay {
  salary: string | null;
  rateMin: number | null;
  rateMax: number | null;
  currency: string | null;
  ratePer: string | null;
  hidePay: boolean;
  barter: boolean;
}

/**
 * Deliberately NOT imported by `companies/company-response.ts` — that file
 * imports `JobCardDTO` from here directly, so there's a single source of
 * truth for the shape without this file ever needing to import anything back
 * from `companies/` (keeps the two response modules' import graph
 * one-directional even though the two *services* are mutually dependent).
 */
export interface JobCompanyRef {
  slug: string;
  nameText: string;
}

export interface JobCardDTO {
  slug: string;
  title: string;
  company: JobCompanyRef | null;
  category: string;
  commitment: string;
  seniority: string;
  format: JobFormat;
  location: string;
  city: string | null;
  timezone: string | null;
  pay: JobPay;
  deadline: string | null;
  startDate: string | null;
  desc: string;
  tags: string[];
  queerRun: boolean;
  qrLabel: string | null;
  status: JobStatus;
  createdAt: string;
}

export interface JobDetailDTO extends JobCardDTO {
  detail: JobDetailBody;
  benefits: string[];
  inclusivity: string[];
  screening: string[];
  contacts: string[];
  email: string | null;
  link: string | null;
  poster: MemberRef | null;
  isPoster: boolean;
  myApplicationStatus: JobApplicationStatus | null;
}

export interface JobApplicationAnswerDTO {
  question: string;
  answer: string;
}

export interface JobApplicationDTO {
  id: string;
  job: { slug: string; title: string };
  applicant: MemberRef | null;
  answers: JobApplicationAnswerDTO[];
  coverNote: string | null;
  status: JobApplicationStatus;
  createdAt: string;
}

function toJobPay(job: Job): JobPay {
  return {
    salary: job.salary,
    rateMin: job.rateMin,
    rateMax: job.rateMax,
    currency: job.currency,
    ratePer: job.ratePer,
    hidePay: job.hidePay,
    barter: job.barter,
  };
}

export function toJobCard(job: Job, company: JobCompanyRef | null): JobCardDTO {
  return {
    slug: job.slug,
    title: job.title,
    company,
    category: job.category,
    commitment: job.commitment,
    seniority: job.seniority,
    format: job.format,
    location: job.location,
    city: job.city,
    timezone: job.timezone,
    pay: toJobPay(job),
    deadline: job.deadline,
    startDate: job.startDate,
    desc: job.desc,
    tags: job.tags,
    queerRun: job.queerRun,
    qrLabel: job.qrLabel,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
  };
}

export function toJobDetail(
  job: Job,
  company: JobCompanyRef | null,
  poster: MemberRef | null,
  isPoster: boolean,
  myApplicationStatus: JobApplicationStatus | null,
): JobDetailDTO {
  return {
    ...toJobCard(job, company),
    detail: job.detail,
    benefits: job.benefits,
    inclusivity: job.inclusivity,
    screening: job.screening,
    contacts: job.contacts,
    email: job.email,
    link: job.link,
    poster,
    isPoster,
    myApplicationStatus,
  };
}

export function toJobApplication(
  app: JobApplication,
  job: { slug: string; title: string },
  applicant: MemberRef | null,
): JobApplicationDTO {
  return {
    id: app.id,
    job,
    applicant,
    answers: app.answers,
    coverNote: app.coverNote,
    status: app.status,
    createdAt: app.createdAt.toISOString(),
  };
}
