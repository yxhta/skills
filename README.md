# skills

Personal agent skills, installable via [`npx skills`](https://github.com/vercel-labs/skills).

## Install

```sh
npx skills add yxhta/skills
```

Install a single skill:

```sh
npx skills add yxhta/skills --skill <name>
```

## Layout

Each skill lives under `skills/<name>/` with a `SKILL.md` (flat layout, per the
`npx skills` convention). Some skills carry agent-specific config alongside
`SKILL.md` (e.g. `agents/openai.yaml`, `config/notion.toml`).
