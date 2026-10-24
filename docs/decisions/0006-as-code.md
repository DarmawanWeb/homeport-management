# 6. Dashboards and diagrams as code

**Status:** accepted

## Context

Grafana dashboards exported as JSON are thousands of lines that nobody reviews, and they silently break when a metric is renamed. Architecture diagrams kept as screenshots go stale the same way.

## Decision

- Grafana dashboards are built in TypeScript (`monitoring/dashboards.ts`) from small panel helpers and provisioned from files on every start.
- Alert rules are a typed list in `monitoring/configs.ts`.
- CI runs every PromQL expression from the dashboards and rules against a real Prometheus, and runs `promtool check config` on the generated configuration.
- Diagrams are described in `scripts/diagrams.ts` and emitted as `.drawio.svg`: an SVG that GitHub renders, carrying the draw.io model so it opens as an editable diagram.

## Consequences

- A metric rename that breaks a panel or rule fails CI instead of showing an empty graph months later.
- Dashboards are reviewed like any other code change.
- Edits made in the Grafana UI do not persist; users who want their own dashboards copy one first.
- Diagram layout is coordinates in code. Small changes are quick; large reshuffles are easier in draw.io, after which the script should be updated to match.
