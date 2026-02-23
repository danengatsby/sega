# KPI Business Dictionary (Plan v3.0)

Data: 23 Feb 2026  
Referinta plan: `PLAN DE DEZVOLTARE PROFESIONAL — APLICATIE DE CONTABILITATE v3.0 | 22 Feb 2026`  
Scop: operationalizarea KPI-urilor business ramase `PARTIAL` in raportul final de conformitate.

## Legenda status

- `IMPLEMENTAT`: formula + sursa + colectare automata sunt deja active.
- `PARTIAL`: formula + sursa sunt definite, dar lipsesc una sau mai multe componente de colectare/review.
- `PLANIFICAT`: KPI definit, dar necesita instrumentare noua sau sursa externa.

## Catalog KPI (business + operational)

| KPI ID | KPI | Capitol plan | Formula calcul | Sursa de date | Frecventa | Owner | Target plan | Status |
|---|---|---|---|---|---|---|---|---|
| BIZ-01 | Reducere munca manuala (%) | 1.1, 1.2.1, 9.2 | `100 * (1 - manual_entries / total_entries)` unde `manual_entries = JournalEntry.sourceModule in ('MANUAL', null)` | `public."JournalEntry"` | Lunar | Chief Accountant | `> 70%` | PARTIAL |
| BIZ-02 | e-Factura transmisa in termen (%) | 1.2.1, 7.1, 9.2 | `100 * fiscal_invoices_submitted_in_time / total_fiscal_invoices` | `public."Invoice"` (`kind`, `issueDate`, `efacturaSubmittedAt`) | Zilnic + lunar | Fiscal Compliance Owner | `> 99.5%` | PARTIAL |
| BIZ-03 | Erori conformitate fiscala (#) | 1.2.2, 7.3, 9.2 | `failed_anaf_exports + rejected_efactura` | `public."ExportJob"`, `public."Invoice"` (`efacturaStatus`) | Lunar | Fiscal Compliance Owner | `= 0` | PARTIAL |
| BIZ-04 | Rata adoptare functionalitati cheie (%) | 1.2.3, 9.2 | `100 * active_users_30d(module) / total_memberships_active` | `public."AuditLog"`, `public."UserCompanyMembership"` | Lunar | Product + PM | `> 85%` | PARTIAL |
| BIZ-05 | Timp onboarding contabil nou (zile) | 9.2 | `avg(first_business_action_at - membership_created_at)` pentru roluri contabile | `public."UserCompanyMembership"`, `public."AuditLog"` | Lunar | PM + HR | `< 2 zile` | PLANIFICAT |
| BIZ-06 | Satisfactie utilizatori (NPS 1-5) | 9.2 | `avg(score_survey)` | Sursa externa survey/UAT | Trimestrial | PM | `> 4.0 / 5` | PLANIFICAT |
| BIZ-07 | ROI la 24 luni (%) | 9.2, 11.1 | `100 * (beneficii_24m - cost_total_24m) / cost_total_24m` | Date financiare interne + KPI BIZ-01/BIZ-03 | Trimestrial | Finance Lead | `> 200%` | PLANIFICAT |
| BIZ-08 | Amortizare investitie (luni) | 9.2 | prima luna in care `beneficii_cumulate >= costuri_cumulate` | Date financiare interne | Trimestrial | Finance Lead | `18-24 luni` | PLANIFICAT |
| OPS-01 | Uptime platforma (%) | 1.1, 6.2, 9.1 | `100 * (1 - downtime/total_time)` | Prometheus + Grafana SLO | Continuu | DevOps | `> 99.9%` | IMPLEMENTAT |
| OPS-02 | Latenta API p95 (ms) | 6.1, 9.1 | p95 pe rute critice (`/api/invoices`, `/api/accounts`, `/api/reports/dashboard-bi`) | k6 + JMeter + workflow CI | Zilnic / per release | Tech Lead | `< 300ms` | IMPLEMENTAT |
| OPS-03 | Timp procesare documente (ore) | 1.2.1, 9.2 | `avg(approvalFinalizedAt - receivedDate)` (AP) si `avg(firstPaymentDate - issueDate)` (AR) | `public."SupplierInvoice"`, `public."Payment"`, `public."Invoice"` | Lunar | Chief Accountant | target intern per companie | PARTIAL |

## Query pack minim (Milestone 1)

Acest set este baseline-ul executabil cerut pentru:
- timp mediu procesare document,
- rata utilizare module cheie,
- rata submit e-Factura in termen.

### 1) e-Factura in termen (lunar)

```sql
SELECT
  date_trunc('month', i."issueDate")::date AS month,
  COUNT(*) FILTER (WHERE i.kind = 'FISCAL') AS total_fiscal,
  COUNT(*) FILTER (
    WHERE i.kind = 'FISCAL'
      AND i."efacturaSubmittedAt" IS NOT NULL
      AND i."efacturaSubmittedAt" <= (i."issueDate" + interval '5 day')
  ) AS submitted_on_time,
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE i.kind = 'FISCAL'
        AND i."efacturaSubmittedAt" IS NOT NULL
        AND i."efacturaSubmittedAt" <= (i."issueDate" + interval '5 day')
    ) / NULLIF(COUNT(*) FILTER (WHERE i.kind = 'FISCAL'), 0),
    2
  ) AS on_time_pct
FROM public."Invoice" i
WHERE i."companyId" = :company_id
GROUP BY 1
ORDER BY 1;
```

### 2) Adoptare module cheie (ultimele 30 zile)

```sql
WITH active_members AS (
  SELECT DISTINCT m."userId"
  FROM public."UserCompanyMembership" m
  WHERE m."companyId" = :company_id
),
usage_events AS (
  SELECT
    a."userId",
    CASE
      WHEN a."tableName" IN ('Invoice', 'Payment', 'SupplierInvoice', 'SupplierPayment') THEN 'commercial'
      WHEN a."tableName" IN ('JournalEntry', 'JournalLine', 'Account') THEN 'accounting'
      WHEN a."tableName" IN ('BankStatement', 'BankStatementLine', 'OpenBankingConnection') THEN 'treasury'
      WHEN a."tableName" IN ('PayrollRun', 'Employee') THEN 'payroll'
      WHEN a."tableName" IN ('Asset', 'AssetDepreciation') THEN 'assets'
      ELSE 'other'
    END AS module
  FROM public."AuditLog" a
  WHERE a."companyId" = :company_id
    AND a."userId" IS NOT NULL
    AND a."timestamp" >= now() - interval '30 day'
)
SELECT
  u.module,
  COUNT(DISTINCT u."userId") AS active_users_30d,
  (SELECT COUNT(*) FROM active_members) AS total_members,
  ROUND(
    100.0 * COUNT(DISTINCT u."userId") / NULLIF((SELECT COUNT(*) FROM active_members), 0),
    2
  ) AS adoption_pct
FROM usage_events u
GROUP BY u.module
ORDER BY u.module;
```

### 3) Timp procesare documente AP/AR

```sql
-- AP: primire factura furnizor -> aprobare finala
SELECT
  date_trunc('month', si."receivedDate")::date AS month,
  ROUND(AVG(EXTRACT(EPOCH FROM (si."approvalFinalizedAt" - si."receivedDate")) / 3600)::numeric, 2) AS ap_avg_hours
FROM public."SupplierInvoice" si
WHERE si."companyId" = :company_id
  AND si."approvalFinalizedAt" IS NOT NULL
GROUP BY 1
ORDER BY 1;

-- AR: emitere factura client -> prima incasare
WITH first_payment AS (
  SELECT p."invoiceId", MIN(p.date) AS first_payment_date
  FROM public."Payment" p
  WHERE p."companyId" = :company_id
    AND p."invoiceId" IS NOT NULL
  GROUP BY p."invoiceId"
)
SELECT
  date_trunc('month', i."issueDate")::date AS month,
  ROUND(AVG(EXTRACT(EPOCH FROM (fp.first_payment_date - i."issueDate")) / 3600)::numeric, 2) AS ar_avg_hours
FROM public."Invoice" i
JOIN first_payment fp ON fp."invoiceId" = i.id
WHERE i."companyId" = :company_id
GROUP BY 1
ORDER BY 1;
```

## Operationalizare minima (urmatorii pasi)

1. Ruleaza query pack-ul lunar si arhiveaza rezultatele in dashboard/export CSV.
2. Publica un snapshot lunar cu `target vs actual` pentru KPI BIZ-01..BIZ-05.
3. Marcheaza KPI-urile `PARTIAL` ca `IMPLEMENTAT` doar dupa minim 30 zile de date continue.
