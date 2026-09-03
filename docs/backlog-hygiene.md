# Backlog hygiene

Use this policy for new issues and when materially revising existing issues. Do not reclassify the historical backlog solely to satisfy it.

## Type and contribution labels

Every new or materially revised issue has exactly one shared type label:

- `type/bug`: observed behavior differs from expected behavior
- `type/feature`: new or expanded user or operator capability
- `type/task`: bounded implementation, maintenance, or operational work
- `type/research`: investigation ending in a decision, recommendation, or useful result

Keep public contribution labels such as `good first issue` and `help wanted` when they remain useful. The shared type label does not replace them.

## Milestones and level of effort

Every open issue in a milestone has exactly one level-of-effort label. Level of effort, abbreviated LOE, is an ordinal estimate of focused work after shaping. It is not additive, a commitment, or a velocity measure.

| Label | Calibration |
| --- | --- |
| `loe/1` | Trivial, typically under five minutes |
| `loe/2` | Small, typically five to fifteen minutes |
| `loe/3` | Bounded, typically around thirty minutes |
| `loe/5` | Moderate, typically one to two focused hours |
| `loe/8` | Large, typically many hours; record why it remains whole |
| `loe/13` | Initiative-scale, typically many days; normally split |

An open `loe/8` or `loe/13` issue records a native blocking dependency or a literal `## Blocking gate` section. A milestone states its objective and testable exit criteria. Cross-repository efforts also use `Epic: <slug>` and explicit links because native dependencies do not cross providers.

## Intentional limits

Use `LIMITED` only when the accepted solution deliberately leaves a capability or scope ceiling. Include these literal sections:

```markdown
## Limit

## Revisit when
```

## Useful comments

Comment only when adding evidence, a decision, changed scope, a dependency, a blocker, validation, or a canonical disposition. Keep acknowledgements and repeated summaries out of the tracker.

## Templates

This repository owns its forms in `.github/ISSUE_TEMPLATE/`. The GitHub forms apply one matching type label and disable blank issue creation in the web chooser.

Small issues should produce short answers. Add evidence, approvals, stop conditions, and recovery detail only when the consequences require them.
