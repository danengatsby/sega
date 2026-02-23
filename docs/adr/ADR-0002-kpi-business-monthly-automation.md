# ADR-0002: KPI Business Monthly Reporting Automation

Date: 2026-02-23  
Status: ACCEPTED

## Context

Capitolul 9 din planul v3.0 cere operationalizarea KPI-urilor business (NPS, adoptie, onboarding, conformitate fiscala).  
KPI-urile tehnice sunt deja automatizate in CI, dar KPI-urile business nu aveau un flux lunar executabil.

## Decizie

Introducem un flux automat de raportare:
1. script backend: `apps/backend/scripts/compliance/generate-monthly-kpi-report.ts`;
2. workflow lunar: `.github/workflows/business-kpi-monthly.yml` (schedule + manual dispatch);
3. output standardizat in `docs/reports/kpi-business-report-YYYY-MM.md`.

Metrici incluse in versiunea initiala:
- BIZ-01: reducere munca manuala;
- BIZ-02: e-Factura on-time;
- BIZ-03: erori conformitate fiscala;
- BIZ-04: adoptie functionalitati;
- BIZ-05: onboarding;
- BIZ-06: satisfactie/NPS (input extern optional).

## Impact business

- permite comparatia periodica `target vs actual` pe KPI business;
- accelereaza detectia devierilor de adoptie/conformitate;
- ofera baza obiectiva pentru executive review trimestrial.

## Trade-offs

- necesita secrete operationale (`KPI_REPORT_DATABASE_URL`, `KPI_REPORT_COMPANY_ID`);
- NPS depinde de o sursa externa si poate ramane `N/A` daca nu este furnizat.

## Follow-up

1. Configureaza secretele workflow in repository settings.
2. Ruleaza primul raport lunar complet in primele 5 zile ale lunii urmatoare.
3. Include rezultatele in `executive-review-YYYY-QN.md`.
