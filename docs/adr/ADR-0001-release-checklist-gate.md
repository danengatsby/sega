# ADR-0001: Release Checklist Gate Soft/Hard

Date: 2026-02-23  
Status: ACCEPTED

## Context

Capitolul 4 din planul v3.0 cere trasabilitate pe livrabile si checklist de release verificabil.  
In lipsa unui gate automat, PR-urile pot ajunge in `main` fara acoperire minima pentru risc, rollback si verificari post-release.

## Decizie

Introducem:
1. template PR obligatoriu (`.github/pull_request_template.md`);
2. workflow `Release Checklist` (`.github/workflows/release-checklist.yml`) care valideaza:
   - prezenta sectiunilor `Livrabile faza`, `Regression risks`, `Verificari post-release`;
   - checklist-ul minim de release;
   - minimum 1 approval valid.

Mod de aplicare:
- `soft` pana la 23 March 2026;
- `hard` incepand cu 23 March 2026.

## Impact business

- scade probabilitatea de regresii in productie;
- creste transparenta intre engineering si stakeholderi;
- reduce timpul de triage post-release prin standardizare.

## Trade-offs

- creste usor overhead-ul la pregatirea PR;
- in perioada initiala pot aparea warning-uri frecvente pana la adoptarea noii discipline.

## Follow-up

1. Activare branch protection cu `Release Checklist` check obligatoriu.
2. Audit dupa 2 sprinturi: rata PR-uri care trec fara warning-uri.
