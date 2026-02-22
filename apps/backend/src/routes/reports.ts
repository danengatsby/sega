import { Router } from 'express';
import {
  createAnafExportHandler,
  exportD406Conformity,
  exportAnafValidation,
  exportFinancialExcel,
  exportFinancialPdf,
  exportFinancialXbrl,
  exportFinancialXml,
  getDashboardBi,
  getAgingReceivables,
  getBalanceSheet,
  getFinancialStatements,
  getPnl,
  getTrialBalance,
} from '../controllers/reports-controller.js';
import { requirePermissions } from '../middleware/auth.js';
import { PERMISSIONS } from '../lib/rbac.js';

const router = Router();

const reportGuard = requirePermissions(PERMISSIONS.REPORTS_READ);
const exportGuard = requirePermissions(PERMISSIONS.REPORTS_EXPORT);

router.get('/trial-balance', reportGuard, getTrialBalance);
router.get('/pnl', reportGuard, getPnl);
router.get('/balance-sheet', reportGuard, getBalanceSheet);
router.get('/aging-receivables', reportGuard, getAgingReceivables);
router.get('/financial-statements', reportGuard, getFinancialStatements);
router.get('/dashboard-bi', reportGuard, getDashboardBi);

router.get('/export/financial.pdf', exportGuard, exportFinancialPdf);
router.get('/export/financial.excel', exportGuard, exportFinancialExcel);
router.get('/export/financial.xml', exportGuard, exportFinancialXml);
router.get('/export/financial.xbrl', exportGuard, exportFinancialXbrl);

router.get('/export/anaf/d300.xml', exportGuard, createAnafExportHandler('d300'));
router.get('/export/anaf/d394.xml', exportGuard, createAnafExportHandler('d394'));
router.get('/export/anaf/d112.xml', exportGuard, createAnafExportHandler('d112'));
router.get('/export/anaf/d101.xml', exportGuard, createAnafExportHandler('d101'));
router.get('/export/anaf/d100.xml', exportGuard, createAnafExportHandler('d100'));
router.get('/export/anaf/d205.xml', exportGuard, createAnafExportHandler('d205'));
router.get('/export/anaf/d392.xml', exportGuard, createAnafExportHandler('d392'));
router.get('/export/anaf/d393.xml', exportGuard, createAnafExportHandler('d393'));
router.get('/export/anaf/d406.xml', exportGuard, createAnafExportHandler('d406'));
router.get('/export/anaf/d406-conformity', exportGuard, exportD406Conformity);
router.get('/export/anaf/validation', exportGuard, exportAnafValidation);

export default router;
