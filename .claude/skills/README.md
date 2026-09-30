# Claude Code skill locations in this repository

Skill content lives in exactly two places in this repo:

- `skills/<name>/SKILL.md` — runtime and operational skills shipped with the app
- `.agents/skills/<name>/SKILL.md` — repository-maintainer agent skills

`.claude/skills/` used to contain symlinks pointing at those two locations, so
Claude Code running in this repo would auto-discover the same skills under a third
path. Those symlinks could not be recreated on a Windows checkout without Developer
Mode, so they were removed rather than committed as 22-byte text stubs that would
break on clone.

If you are on a platform that supports symlinks and want the convenience, recreate
them with:

```sh
cd .claude/skills
ln -s ../../skills/paperclip paperclip
ln -s ../../.agents/skills/company-creator company-creator
```

Do not commit them. Nothing in the build, the test suite, or the server reads
`.claude/skills/`; it exists only for editor-side skill discovery.
