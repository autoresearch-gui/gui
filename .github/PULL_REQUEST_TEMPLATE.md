# Pull Request

## Thinking Path

<!--
  Required. Trace your reasoning from the top of the project down to this
  specific change. Start with what this project is, then narrow through the
  subsystem, the problem, and why this PR exists. Use blockquote style.
  Aim for 5-8 steps.
-->

> - This project is ...
> - [Which subsystem or capability is involved]
> - [What problem or gap exists]
> - [Why it needs to be addressed]
> - This pull request ...
> - The benefit is ...

## What Changed

<!-- Bullet list of concrete changes. One bullet per logical unit. -->

-

## Verification

<!--
  How can a reviewer confirm this works? Include test commands, manual
  steps, or both. If a check could not be run, say so and say why.
-->

-

## Risks

<!--
  What could go wrong? Mention migration safety, breaking changes,
  behavioral shifts, or "Low risk" if genuinely minor.
-->

-

## Model Used

<!--
  Required. Specify which AI model was used to produce or assist with
  this change. Be as descriptive as possible - include:
    - Provider and model name
    - Exact model ID or version
    - Context window size if relevant
    - Reasoning/thinking mode if applicable
    - Any other relevant capability details (e.g. tool use, code execution)
  If no AI model was used, write "None - human-authored".
-->

-

## Checklist

- [ ] I have included a thinking path that traces from project context to this change
- [ ] I have specified the model used (with version and capability details)
- [ ] I have linked an existing issue with `Fixes: #` / `Closes: #` / `Refs #`, or described the problem above
- [ ] I have run `pnpm -r typecheck` and `pnpm test:run` locally and they pass
- [ ] I have added or updated tests where applicable
- [ ] I have updated relevant documentation to reflect my changes
- [ ] If I touched `ui/`, I have run `pnpm check:token-gates` and it passes
- [ ] I have considered and documented any risks above
- [ ] I have not committed secrets, keys, or `.env` files
