import { PayrollStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { invalidateFinancialStatementsCache } from '../lib/financial-statements-cache.js';
import { nextJournalEntryNumber } from '../lib/journal-entry-number.js';
import { logger } from '../lib/logger.js';
import { enqueueNotificationEvent } from '../lib/notification-queue.js';
import { assertPeriodOpen } from '../lib/period-lock.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { writeAudit } from '../lib/audit.js';
import { HttpError } from '../lib/http-error.js';
import { requirePermissions } from '../middleware/auth.js';
import { currentPeriod } from '../utils/accounting.js';
import { round2, toNumber } from '../utils/number.js';
import { parsePeriod } from '../utils/period.js';
import { buildSimplePdf } from '../utils/pdf.js';

const router = Router();

const generateSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  payDate: z.string().datetime().optional(),
  autoPost: z.boolean().default(true),
  salaryExpenseAccountCode: z.string().default('641'),
  camExpenseAccountCode: z.string().default('646'),
  salaryPayableAccountCode: z.string().default('421'),
  casAccountCode: z.string().default('4315'),
  cassAccountCode: z.string().default('4316'),
  camAccountCode: z.string().default('4317'),
  taxAccountCode: z.string().default('444'),
  reason: z.string().optional(),
});

function payrollStatusLabel(status: PayrollStatus): string {
  switch (status) {
    case PayrollStatus.DRAFT:
      return 'Draft';
    case PayrollStatus.POSTED:
      return 'Postat';
    default:
      return status;
  }
}

router.get('/export/employees/pdf', requirePermissions(PERMISSIONS.PAYROLL_READ), async (req, res) => {
  const companyId = req.user!.companyId!;
  const [company, employees] = await Promise.all([
    prisma.company.findUnique({
      where: {
        id: companyId,
      },
      select: {
        code: true,
        name: true,
      },
    }),
    prisma.employee.findMany({
      where: {
        companyId,
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: {
        cnp: true,
        name: true,
        contractType: true,
        grossSalary: true,
        personalDeduction: true,
        isActive: true,
        hiredAt: true,
      },
    }),
  ]);

  const generatedAt = new Date().toLocaleString('ro-RO');
  const activeCount = employees.filter((employee) => employee.isActive).length;
  const totalGross = round2(employees.reduce((sum, employee) => sum + toNumber(employee.grossSalary), 0));

  const lines: string[] = [
    'SEGA Accounting - Lista angajati',
    `Companie: ${company?.name ?? req.user?.companyName ?? 'N/A'} (${company?.code ?? req.user?.companyCode ?? 'N/A'})`,
    `Generat la: ${generatedAt}`,
    `Total angajati: ${employees.length} | Activi: ${activeCount} | Total brut lunar: ${totalGross.toFixed(2)}`,
    '',
    'Nume | CNP | Contract | Brut | Deducere | Activ | Data angajare',
    '--------------------------------------------------------------------------------------------------------------',
    ...employees.map((employee) => {
      return `${employee.name} | ${employee.cnp} | ${employee.contractType} | ${toNumber(employee.grossSalary).toFixed(
        2,
      )} | ${toNumber(employee.personalDeduction).toFixed(2)} | ${employee.isActive ? 'DA' : 'NU'} | ${employee.hiredAt.toLocaleDateString(
        'ro-RO',
      )}`;
    }),
  ];

  const pdf = buildSimplePdf(lines);
  const safeCompanyCode = (company?.code ?? req.user?.companyCode ?? 'companie')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="angajati-${safeCompanyCode}.pdf"`);
  res.send(pdf);
});

router.get('/export/runs/pdf', requirePermissions(PERMISSIONS.PAYROLL_READ), async (req, res) => {
  const companyId = req.user!.companyId!;
  const [company, runs] = await Promise.all([
    prisma.company.findUnique({
      where: {
        id: companyId,
      },
      select: {
        code: true,
        name: true,
      },
    }),
    prisma.payrollRun.findMany({
      where: {
        companyId,
      },
      include: {
        lines: {
          select: {
            id: true,
          },
        },
      },
      orderBy: [{ period: 'desc' }, { payDate: 'desc' }],
      take: 36,
    }),
  ]);

  const generatedAt = new Date().toLocaleString('ro-RO');
  const totalNet = round2(runs.reduce((sum, run) => sum + toNumber(run.totalNet), 0));
  const totalGross = round2(runs.reduce((sum, run) => sum + toNumber(run.totalGross), 0));

  const lines: string[] = [
    'SEGA Accounting - Lista state salarii',
    `Companie: ${company?.name ?? req.user?.companyName ?? 'N/A'} (${company?.code ?? req.user?.companyCode ?? 'N/A'})`,
    `Generat la: ${generatedAt}`,
    `State listate: ${runs.length} | Total brut: ${totalGross.toFixed(2)} | Total net: ${totalNet.toFixed(2)}`,
    '',
    'Perioada | Data plata | Status | Angajati | Brut | Net | CAS | CASS | CAM | Impozit',
    '--------------------------------------------------------------------------------------------------------------',
    ...runs.map((run) => {
      return `${run.period} | ${run.payDate.toLocaleDateString('ro-RO')} | ${payrollStatusLabel(run.status)} | ${run.lines.length} | ${toNumber(
        run.totalGross,
      ).toFixed(2)} | ${toNumber(run.totalNet).toFixed(2)} | ${toNumber(run.totalCas).toFixed(2)} | ${toNumber(
        run.totalCass,
      ).toFixed(2)} | ${toNumber(run.totalCam).toFixed(2)} | ${toNumber(run.totalTax).toFixed(2)}`;
    }),
  ];

  const pdf = buildSimplePdf(lines);
  const safeCompanyCode = (company?.code ?? req.user?.companyCode ?? 'companie')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="state-salarii-${safeCompanyCode}.pdf"`);
  res.send(pdf);
});

router.get(
  '/runs',
  requirePermissions(PERMISSIONS.PAYROLL_READ),
  async (req, res) => {
    const companyId = req.user!.companyId!;
    const runs = await prisma.payrollRun.findMany({
      where: { companyId },
      include: {
        lines: {
          include: {
            employee: true,
          },
        },
      },
      orderBy: [{ period: 'desc' }],
      take: 24,
    });

    res.json(runs);
  },
);

router.get(
  '/runs/:id',
  requirePermissions(PERMISSIONS.PAYROLL_READ),
  async (req, res) => {
    const runId = String(req.params.id);
    const run = await prisma.payrollRun.findFirst({
      where: {
        id: runId,
        companyId: req.user!.companyId!,
      },
      include: {
        lines: {
          include: {
            employee: true,
          },
        },
      },
    });

    if (!run) {
      res.status(404).json({ message: 'Rularea de salarii nu există.' });
      return;
    }

    res.json(run);
  },
);

router.post(
  '/runs/generate',
  requirePermissions(PERMISSIONS.PAYROLL_GENERATE),
  async (req, res) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Date invalide pentru generarea salariilor.' });
      return;
    }

    parsePeriod(parsed.data.period);
    await assertPeriodOpen(req.user!.companyId!, parsed.data.period);

    const existingRun = await prisma.payrollRun.findFirst({
      where: {
        companyId: req.user!.companyId!,
        period: parsed.data.period,
      },
    });
    if (existingRun) {
      res.status(409).json({ message: `Există deja un stat de salarii pentru perioada ${parsed.data.period}.` });
      return;
    }

    const employees = await prisma.employee.findMany({
      where: {
        companyId: req.user!.companyId!,
        isActive: true,
      },
      orderBy: [{ name: 'asc' }],
    });

    if (employees.length === 0) {
      res.status(400).json({ message: 'Nu există angajați activi pentru calcul salarii.' });
      return;
    }

    const payDate = parsed.data.payDate ? new Date(parsed.data.payDate) : new Date();

    const run = await prisma.$transaction(async (tx) => {
      const lines = employees.map((employee) => {
        const grossSalary = round2(toNumber(employee.grossSalary));
        const personalDeduction = round2(toNumber(employee.personalDeduction));
        const cas = round2(grossSalary * 0.25);
        const cass = round2(grossSalary * 0.1);
        const taxableBase = Math.max(round2(grossSalary - cas - cass - personalDeduction), 0);
        const incomeTax = round2(taxableBase * 0.1);
        const cam = round2(grossSalary * 0.0225);
        const netSalary = round2(grossSalary - cas - cass - incomeTax);

        return {
          employeeId: employee.id,
          grossSalary,
          personalDeduction,
          cas,
          cass,
          incomeTax,
          cam,
          netSalary,
        };
      });

      const totals = lines.reduce(
        (acc, line) => {
          acc.totalGross = round2(acc.totalGross + line.grossSalary);
          acc.totalNet = round2(acc.totalNet + line.netSalary);
          acc.totalCas = round2(acc.totalCas + line.cas);
          acc.totalCass = round2(acc.totalCass + line.cass);
          acc.totalTax = round2(acc.totalTax + line.incomeTax);
          acc.totalCam = round2(acc.totalCam + line.cam);
          return acc;
        },
        {
          totalGross: 0,
          totalNet: 0,
          totalCas: 0,
          totalCass: 0,
          totalTax: 0,
          totalCam: 0,
        },
      );

      let journalEntryId: string | undefined;

      if (parsed.data.autoPost) {
        const [salaryExpense, camExpense, salaryPayable, casAccount, cassAccount, camAccount, taxAccount] = await Promise.all([
          tx.account.findFirst({
            where: {
              companyId: req.user!.companyId!,
              code: parsed.data.salaryExpenseAccountCode,
            },
          }),
          tx.account.findFirst({
            where: {
              companyId: req.user!.companyId!,
              code: parsed.data.camExpenseAccountCode,
            },
          }),
          tx.account.findFirst({
            where: {
              companyId: req.user!.companyId!,
              code: parsed.data.salaryPayableAccountCode,
            },
          }),
          tx.account.findFirst({
            where: {
              companyId: req.user!.companyId!,
              code: parsed.data.casAccountCode,
            },
          }),
          tx.account.findFirst({
            where: {
              companyId: req.user!.companyId!,
              code: parsed.data.cassAccountCode,
            },
          }),
          tx.account.findFirst({
            where: {
              companyId: req.user!.companyId!,
              code: parsed.data.camAccountCode,
            },
          }),
          tx.account.findFirst({
            where: {
              companyId: req.user!.companyId!,
              code: parsed.data.taxAccountCode,
            },
          }),
        ]);

        if (!salaryExpense || !camExpense || !salaryPayable || !casAccount || !cassAccount || !camAccount || !taxAccount) {
          throw HttpError.badRequest('Conturile pentru postare salarii nu sunt configurate corect.');
        }

        const journalLines: Array<{
          accountId: string;
          debit: number;
          credit: number;
          explanation: string;
        }> = [
          {
            accountId: salaryExpense.id,
            debit: totals.totalGross,
            credit: 0,
            explanation: `Cheltuială salarii ${parsed.data.period}`,
          },
          {
            accountId: camExpense.id,
            debit: totals.totalCam,
            credit: 0,
            explanation: `Cheltuială CAM ${parsed.data.period}`,
          },
          {
            accountId: salaryPayable.id,
            debit: 0,
            credit: totals.totalNet,
            explanation: `Datorii salarii nete ${parsed.data.period}`,
          },
          {
            accountId: casAccount.id,
            debit: 0,
            credit: totals.totalCas,
            explanation: `Contribuție CAS ${parsed.data.period}`,
          },
          {
            accountId: cassAccount.id,
            debit: 0,
            credit: totals.totalCass,
            explanation: `Contribuție CASS ${parsed.data.period}`,
          },
          {
            accountId: camAccount.id,
            debit: 0,
            credit: totals.totalCam,
            explanation: `Contribuție asiguratorie muncă (CAM) ${parsed.data.period}`,
          },
        ];

        if (totals.totalTax > 0) {
          journalLines.push({
            accountId: taxAccount.id,
            debit: 0,
            credit: totals.totalTax,
            explanation: `Impozit salarii ${parsed.data.period}`,
          });
        }

        const journalNumber = await nextJournalEntryNumber(tx, req.user!.companyId!, payDate);
        const journalEntry = await tx.journalEntry.create({
          data: {
            companyId: req.user!.companyId!,
            number: journalNumber,
            date: payDate,
            description: `Stat salarii ${parsed.data.period}`,
            period: parsed.data.period || currentPeriod(payDate),
            sourceModule: 'PAYROLL',
            createdById: req.user!.id,
            lines: {
              create: journalLines,
            },
          },
        });

        journalEntryId = journalEntry.id;
      }

      const payrollRun = await tx.payrollRun.create({
        data: {
          companyId: req.user!.companyId!,
          period: parsed.data.period,
          payDate,
          status: parsed.data.autoPost ? PayrollStatus.POSTED : PayrollStatus.DRAFT,
          totalGross: totals.totalGross,
          totalNet: totals.totalNet,
          totalCas: totals.totalCas,
          totalCass: totals.totalCass,
          totalTax: totals.totalTax,
          totalCam: totals.totalCam,
          createdById: req.user!.id,
          journalEntryId,
          lines: {
            create: lines,
          },
        },
        include: {
          lines: {
            include: {
              employee: true,
            },
          },
        },
      });

      return payrollRun;
    });

    await writeAudit(req, {
      tableName: 'payroll_runs',
      recordId: run.id,
      action: 'CREATE',
      reason: parsed.data.reason,
      afterData: {
        period: run.period,
        totalGross: run.totalGross,
        totalNet: run.totalNet,
        totalCam: run.totalCam,
        lineCount: run.lines.length,
      },
    });

    invalidateFinancialStatementsCache();
    void enqueueNotificationEvent({
      type: 'PAYROLL_RUN_GENERATED',
      companyId: req.user!.companyId!,
      companyName: req.user!.companyName,
      triggeredByUserId: req.user!.id,
      payload: {
        payrollRunId: run.id,
        period: run.period,
        employeeCount: run.lines.length,
        totalNet: toNumber(run.totalNet),
        totalGross: toNumber(run.totalGross),
        totalCam: toNumber(run.totalCam),
        currency: 'RON',
      },
    }).catch((error) => {
      logger.warn('notification_enqueue_failed', {
        eventType: 'PAYROLL_RUN_GENERATED',
        companyId: req.user!.companyId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    res.status(201).json(run);
  },
);

export default router;
