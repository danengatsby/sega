import 'dotenv/config';
import bcrypt from 'bcrypt';
import { DepreciationMethod, Role } from '@prisma/client';
import { env } from './config/env.js';
import { OMFP_ACCOUNTS, OMFP_ACCOUNTS_COUNT } from './data/omfp-chart.js';
import { prisma } from './lib/prisma.js';

async function main() {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    throw new Error('Pentru seed sunt necesare variabilele ADMIN_EMAIL și ADMIN_PASSWORD.');
  }

  const company = await prisma.company.upsert({
    where: { code: 'default' },
    update: {
      name: 'SEGA Demo Company',
      cui: env.ANAF_COMPANY_CUI,
      isActive: true,
    },
    create: {
      code: 'default',
      name: 'SEGA Demo Company',
      cui: env.ANAF_COMPANY_CUI,
      isActive: true,
    },
  });

  const passwordHash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);

  const adminUser = await prisma.user.upsert({
    where: { email: env.ADMIN_EMAIL },
    update: {
      name: 'Administrator',
      role: Role.ADMIN,
      passwordHash,
      mustChangePassword: true,
    },
    create: {
      email: env.ADMIN_EMAIL,
      name: 'Administrator',
      role: Role.ADMIN,
      passwordHash,
      mustChangePassword: true,
    },
  });

  await prisma.userCompanyMembership.upsert({
    where: {
      userId_companyId: {
        userId: adminUser.id,
        companyId: company.id,
      },
    },
    update: {
      role: Role.ADMIN,
      isDefault: true,
    },
    create: {
      userId: adminUser.id,
      companyId: company.id,
      role: Role.ADMIN,
      isDefault: true,
    },
  });

  await prisma.account.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.journalEntry.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.partner.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.invoice.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.payment.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.supplierInvoice.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.supplierPayment.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.asset.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.stockItem.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.stockMovement.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.stockLot.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.employee.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.payrollRun.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  await prisma.auditLog.updateMany({
    where: { companyId: null },
    data: { companyId: company.id },
  });

  const ACCOUNT_BATCH_SIZE = 100;
  for (let index = 0; index < OMFP_ACCOUNTS.length; index += ACCOUNT_BATCH_SIZE) {
    const batch = OMFP_ACCOUNTS.slice(index, index + ACCOUNT_BATCH_SIZE);
    await prisma.$transaction(
      batch.map((account) =>
        prisma.account.upsert({
          where: {
            companyId_code: {
              companyId: company.id,
              code: account.code,
            },
          },
          update: {
            companyId: company.id,
            name: account.name,
            type: account.type,
            currency: 'RON',
            isActive: true,
          },
          create: {
            companyId: company.id,
            code: account.code,
            name: account.name,
            type: account.type,
            currency: 'RON',
          },
        }),
      ),
    );
  }

  await prisma.employee.upsert({
    where: {
      companyId_cnp: {
        companyId: company.id,
        cnp: '1900101223344',
      },
    },
    update: {
      companyId: company.id,
      name: 'Popescu Andrei',
      contractType: 'CIM',
      grossSalary: 8500,
      personalDeduction: 0,
      isActive: true,
    },
    create: {
      companyId: company.id,
      cnp: '1900101223344',
      name: 'Popescu Andrei',
      contractType: 'CIM',
      grossSalary: 8500,
      personalDeduction: 0,
      isActive: true,
    },
  });

  await prisma.asset.upsert({
    where: {
      companyId_code: {
        companyId: company.id,
        code: 'MF-0001',
      },
    },
    update: {
      companyId: company.id,
      name: 'Server contabilitate',
      value: 24000,
      residualValue: 2000,
      depreciationMethod: DepreciationMethod.LINEAR,
      usefulLifeMonths: 60,
      isActive: true,
    },
    create: {
      companyId: company.id,
      code: 'MF-0001',
      name: 'Server contabilitate',
      value: 24000,
      residualValue: 2000,
      depreciationMethod: DepreciationMethod.LINEAR,
      startDate: new Date(),
      usefulLifeMonths: 60,
      isActive: true,
    },
  });

  await prisma.stockItem.upsert({
    where: {
      companyId_code: {
        companyId: company.id,
        code: 'MAT-001',
      },
    },
    update: {
      companyId: company.id,
      name: 'Materie primă demo',
      unit: 'KG',
      valuationMethod: 'FIFO',
      minStockQty: 100,
      isActive: true,
    },
    create: {
      companyId: company.id,
      code: 'MAT-001',
      name: 'Materie primă demo',
      unit: 'KG',
      valuationMethod: 'FIFO',
      minStockQty: 100,
      quantityOnHand: 0,
      avgUnitCost: 0,
      isActive: true,
    },
  });

  console.log(`Seed completed. Plan de conturi OMFP: ${OMFP_ACCOUNTS_COUNT} conturi.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
