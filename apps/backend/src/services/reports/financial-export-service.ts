import { buildSimplePdf } from '../../utils/pdf.js';
import { csvCell, formatAmount, xmlEscape } from './helpers.js';
import type { FinancialStatementBundle } from './types.js';

export function buildExcelContent(bundle: FinancialStatementBundle): string {
  const rows: string[][] = [];

  rows.push(['SEGA Accounting - Situații Financiare']);
  rows.push(['Generat la', bundle.meta.generatedAt]);
  rows.push(['Interval', `${bundle.meta.from ?? 'N/A'} - ${bundle.meta.to ?? 'N/A'}`]);
  rows.push([]);

  rows.push(['Balanță de verificare']);
  rows.push(['Cont', 'Denumire', 'Tip', 'Debit', 'Credit']);
  for (const row of bundle.trialBalance.rows) {
    rows.push([row.code, row.name, row.type, formatAmount(row.debit), formatAmount(row.credit)]);
  }
  rows.push(['TOTAL', '', '', formatAmount(bundle.trialBalance.totals.debit), formatAmount(bundle.trialBalance.totals.credit)]);
  rows.push([]);

  rows.push(['Profit și Pierdere']);
  rows.push(['Venituri', formatAmount(bundle.pnl.revenues)]);
  rows.push(['Cheltuieli', formatAmount(bundle.pnl.expenses)]);
  rows.push(['Rezultat net', formatAmount(bundle.pnl.netProfit)]);
  rows.push([]);

  rows.push(['Bilanț']);
  rows.push(['Active', formatAmount(bundle.balanceSheet.assets)]);
  rows.push(['Datorii', formatAmount(bundle.balanceSheet.liabilities)]);
  rows.push(['Capitaluri proprii', formatAmount(bundle.balanceSheet.equity)]);
  rows.push(['Datorii + Capitaluri', formatAmount(bundle.balanceSheet.liabilitiesAndEquity)]);
  rows.push([]);

  rows.push(['Sumar fiscal']);
  rows.push(['Bază taxabilă vânzări', formatAmount(bundle.taxSummary.taxableSales)]);
  rows.push(['TVA colectată', formatAmount(bundle.taxSummary.vatCollected)]);
  rows.push(['CAS salarii', formatAmount(bundle.taxSummary.payrollCas)]);
  rows.push(['CASS salarii', formatAmount(bundle.taxSummary.payrollCass)]);
  rows.push(['Impozit salarii', formatAmount(bundle.taxSummary.payrollTax)]);
  rows.push(['Estimare impozit profit', formatAmount(bundle.taxSummary.estimatedProfitTax)]);
  rows.push(['Total obligații fiscale', formatAmount(bundle.taxSummary.totalFiscalLiabilities)]);

  return rows.map((row) => row.map((cell) => csvCell(cell)).join(',')).join('\n');
}

export function buildXmlContent(bundle: FinancialStatementBundle): string {
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<financialStatements>');
  lines.push(`  <generatedAt>${xmlEscape(bundle.meta.generatedAt)}</generatedAt>`);
  lines.push('  <period>');
  lines.push(`    <from>${xmlEscape(bundle.meta.from ?? '')}</from>`);
  lines.push(`    <to>${xmlEscape(bundle.meta.to ?? '')}</to>`);
  lines.push('  </period>');

  lines.push('  <trialBalance>');
  lines.push(
    `    <totals debit="${formatAmount(bundle.trialBalance.totals.debit)}" credit="${formatAmount(bundle.trialBalance.totals.credit)}" />`,
  );
  for (const row of bundle.trialBalance.rows) {
    lines.push(
      `    <account code="${xmlEscape(row.code)}" type="${xmlEscape(row.type)}" debit="${formatAmount(row.debit)}" credit="${formatAmount(row.credit)}">${xmlEscape(row.name)}</account>`,
    );
  }
  lines.push('  </trialBalance>');

  lines.push('  <profitAndLoss>');
  lines.push(`    <revenues>${formatAmount(bundle.pnl.revenues)}</revenues>`);
  lines.push(`    <expenses>${formatAmount(bundle.pnl.expenses)}</expenses>`);
  lines.push(`    <netProfit>${formatAmount(bundle.pnl.netProfit)}</netProfit>`);
  lines.push('  </profitAndLoss>');

  lines.push('  <balanceSheet>');
  lines.push(`    <assets>${formatAmount(bundle.balanceSheet.assets)}</assets>`);
  lines.push(`    <liabilities>${formatAmount(bundle.balanceSheet.liabilities)}</liabilities>`);
  lines.push(`    <equity>${formatAmount(bundle.balanceSheet.equity)}</equity>`);
  lines.push(`    <liabilitiesAndEquity>${formatAmount(bundle.balanceSheet.liabilitiesAndEquity)}</liabilitiesAndEquity>`);
  lines.push('  </balanceSheet>');

  lines.push('  <taxSummary>');
  lines.push(`    <taxableSales>${formatAmount(bundle.taxSummary.taxableSales)}</taxableSales>`);
  lines.push(`    <vatCollected>${formatAmount(bundle.taxSummary.vatCollected)}</vatCollected>`);
  lines.push(`    <payrollCas>${formatAmount(bundle.taxSummary.payrollCas)}</payrollCas>`);
  lines.push(`    <payrollCass>${formatAmount(bundle.taxSummary.payrollCass)}</payrollCass>`);
  lines.push(`    <payrollTax>${formatAmount(bundle.taxSummary.payrollTax)}</payrollTax>`);
  lines.push(`    <estimatedProfitTax>${formatAmount(bundle.taxSummary.estimatedProfitTax)}</estimatedProfitTax>`);
  lines.push(`    <totalFiscalLiabilities>${formatAmount(bundle.taxSummary.totalFiscalLiabilities)}</totalFiscalLiabilities>`);
  lines.push('  </taxSummary>');
  lines.push('</financialStatements>');

  return lines.join('\n');
}

function buildPdfLines(bundle: FinancialStatementBundle): string[] {
  return [
    'SEGA Accounting - Situatii Financiare',
    `Generat la: ${bundle.meta.generatedAt}`,
    `Interval: ${bundle.meta.from ?? 'N/A'} - ${bundle.meta.to ?? 'N/A'}`,
    '',
    'Profit si Pierdere',
    `Venituri: ${formatAmount(bundle.pnl.revenues)} RON`,
    `Cheltuieli: ${formatAmount(bundle.pnl.expenses)} RON`,
    `Rezultat net: ${formatAmount(bundle.pnl.netProfit)} RON`,
    '',
    'Bilant',
    `Active: ${formatAmount(bundle.balanceSheet.assets)} RON`,
    `Datorii: ${formatAmount(bundle.balanceSheet.liabilities)} RON`,
    `Capitaluri proprii: ${formatAmount(bundle.balanceSheet.equity)} RON`,
    `Datorii + Capitaluri: ${formatAmount(bundle.balanceSheet.liabilitiesAndEquity)} RON`,
    '',
    'Sumar fiscal',
    `TVA colectata: ${formatAmount(bundle.taxSummary.vatCollected)} RON`,
    `CAS: ${formatAmount(bundle.taxSummary.payrollCas)} RON`,
    `CASS: ${formatAmount(bundle.taxSummary.payrollCass)} RON`,
    `Impozit salarii: ${formatAmount(bundle.taxSummary.payrollTax)} RON`,
    `Impozit profit estimat: ${formatAmount(bundle.taxSummary.estimatedProfitTax)} RON`,
    `Total obligatii fiscale: ${formatAmount(bundle.taxSummary.totalFiscalLiabilities)} RON`,
  ];
}

export function buildPdfContent(bundle: FinancialStatementBundle): Buffer {
  return buildSimplePdf(buildPdfLines(bundle));
}
