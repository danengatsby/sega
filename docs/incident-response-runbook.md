# Incident Response Runbook (SEGA)
Data: 24 februarie 2026

## Scope
Runbook operațional pentru incidente de disponibilitate/performanță/securitate detectate prin observability stack.

## Surse alertare
- Prometheus rules: `infra/prometheus/slo-alerts.yml`
- Alertmanager: `infra/prometheus/alertmanager.yml`
- Dashboard SLO: `infra/grafana/dashboards/sega-slo-overview.json`

## Severități
- `critical`: serviciu indisponibil, impact major utilizatori.
- `warning`: degradare SLA (latency/error-rate), fără indisponibilitate totală.

## Triage (primele 15 minute)
1. Confirmă alertă în Alertmanager (`/alerts`).
2. Verifică health endpoint API (`/api/health`) și metrici (`/metrics`).
3. Verifică ultimele deployment-uri și schimbări de configurație.
4. Decide: rollback, restart controlat, sau mitigare punctuală.

## Acțiuni recomandate
1. Incident disponibilitate (`SegaBackendDown`):
   - verificare procese/container/pod,
   - restart controlat,
   - fallback read-only dacă DB are degradare.
2. Incident latență (`SegaApiLatencyP95High`):
   - verificare CPU/IO/lock DB,
   - reducere trafic non-critic (jobs batch),
   - investigare query-uri lente.
3. Incident error-rate (`SegaApi5xxRateHigh`):
   - verificare logs de aplicație,
   - identificare endpoint dominant 5xx,
   - rollback dacă incidentul e corelat cu release nou.

## Post-incident
1. Documentare timeline + root cause.
2. Definire acțiuni preventive (test, alertă, limită nouă).
3. Actualizare risk register și, dacă e cazul, backlog de conformitate.
