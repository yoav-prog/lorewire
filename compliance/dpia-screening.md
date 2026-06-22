# DPIA screening (GDPR Article 35)

Purpose: decide whether LoreWire's processing requires a full Data Protection
Impact Assessment. This is the screening and its reasoning, not the DPIA itself.
`TODO(legal)`: confirm this conclusion.

## When a DPIA is mandatory

Article 35(3) and the EDPB criteria require a DPIA when processing is "likely to
result in a high risk," typically when two or more of these apply: evaluation/
scoring or profiling; automated decisions with legal/significant effect;
systematic monitoring; sensitive or special-category data; data on a large
scale; matching/combining datasets; vulnerable data subjects; innovative use of
technology; processing that prevents a right or contract.

## How LoreWire measures against them

| Criterion | LoreWire | Met? |
|---|---|---|
| Profiling / scoring | Reader activity personalizes the user's own list; no scoring of people, no decisions about them | No |
| Automated decisions with legal/significant effect | None | No |
| Systematic monitoring | No cross-site tracking, no analytics SDKs, no behavioral surveillance; only first-party functional state | No |
| Special-category data (Art. 9) | None collected (no health, politics, biometrics, etc.) | No |
| Large scale | `TODO(operator)`: current user numbers are small; reassess if usage grows materially | Not currently |
| Combining datasets | The `lw_anon` to account stitch links a single device's prior activity to its own new account; not cross-source matching | Borderline / low |
| Vulnerable subjects | Service is 16+ and not directed at children | No |
| Innovative technology | Standard web app; AI is used on operator content, not to make decisions about users | No |

## Conclusion

A full DPIA does **not** currently appear to be mandatory: no special-category
data, no profiling or automated decisions about people, no systematic
monitoring, and small scale. The closest factors (the anonymous-to-account
activity stitch, and the IP+UA hash for poll abuse prevention) are low risk —
single-source, hashed, short-retention, and tied to features the user engaged
with.

## Conditions that would change this

Run a full DPIA before launching any of the following:

- Profiling or recommendation that scores users or targets content/ads based on
  inferred traits.
- Any third-party analytics, advertising, or tracking SDK.
- Collection of special-category data.
- A material increase in scale combined with behavioral monitoring.
- Feeding user-generated personal content into the AI pipeline.

`TODO(legal)`: sign off on this screening, or commission a full DPIA if counsel
disagrees.
