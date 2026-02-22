import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PayrollStatus, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { buildD112Xml } from './anaf-service.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let companyId: string | null = null;
let userId: string | null = null;
let employeeId: string | null = null;
let payrollRunId: string | null = null;

before(async () => {
  const company = await prisma.company.create({
    data: {
      code: `d112-${RUN_ID}`,
      name: `D112 CAM ${RUN_ID}`,
      isActive: true,
    },
  });
  companyId = company.id;

  const user = await prisma.user.create({
    data: {
      email: `d112-${RUN_ID}@sega.test`,
      name: 'D112 CAM Test',
      passwordHash: 'test-password-hash',
      mustChangePassword: false,
      role: Role.ADMIN,
      mfaEnabled: false,
    },
  });
  userId = user.id;

  const employee = await prisma.employee.create({
    data: {
      companyId: company.id,
      cnp: `2990101${RUN_ID.replace(/[^0-9]/g, '').slice(-6).padStart(6, '0')}`,
      name: 'Employee D112 CAM',
      contractType: 'CIM',
      grossSalary: 10000,
      personalDeduction: 0,
      isActive: true,
    },
  });
  employeeId = employee.id;

  const payrollRun = await prisma.payrollRun.create({
    data: {
      companyId: company.id,
      period: '2026-02',
      payDate: new Date('2026-02-20T10:00:00.000Z'),
      status: PayrollStatus.POSTED,
      totalGross: 10000,
      totalNet: 5850,
      totalCas: 2500,
      totalCass: 1000,
      totalTax: 650,
      totalCam: 225,
      createdById: user.id,
      lines: {
        create: [
          {
            employeeId: employee.id,
            grossSalary: 10000,
            personalDeduction: 0,
            cas: 2500,
            cass: 1000,
            incomeTax: 650,
            cam: 225,
            netSalary: 5850,
          },
        ],
      },
    },
  });
  payrollRunId = payrollRun.id;
});

after(async () => {
  if (payrollRunId) {
    await prisma.payrollLine.deleteMany({
      where: { runId: payrollRunId },
    });
    await prisma.payrollRun.deleteMany({
      where: { id: payrollRunId },
    });
  }

  if (employeeId) {
    await prisma.employee.deleteMany({
      where: { id: employeeId },
    });
  }

  if (companyId) {
    await prisma.auditLog.deleteMany({
      where: { companyId },
    });
    await prisma.auditLog.updateMany({
      where: { companyId },
      data: { companyId: null },
    });
    await prisma.company.deleteMany({
      where: { id: companyId },
    });
  }

  if (userId) {
    await prisma.auditLog.updateMany({
      where: { userId },
      data: { userId: null },
    });
    await prisma.refreshSession.deleteMany({
      where: { userId },
    });
    await prisma.userCompanyMembership.deleteMany({
      where: { userId },
    });
    await prisma.user.deleteMany({
      where: { id: userId },
    });
  }
});

test('D112 include datCAM și bifa_CAM când există CAM în statele de salarii', async () => {
  assert.ok(companyId, 'Fixture company lipsă');

  const payload = await buildD112Xml(companyId, {
    period: '2026-02',
    start: new Date('2026-02-01T00:00:00.000Z'),
    end: new Date('2026-02-28T23:59:59.999Z'),
  });

  assert.match(payload.xml, /datCAM="225"/, 'D112 trebuie să includă total CAM în atributul datCAM');
  assert.match(payload.xml, /bifa_CAM="1"/, 'D112 trebuie să marcheze bifa_CAM=1 când CAM > 0');
});
