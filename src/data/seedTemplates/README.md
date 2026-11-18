# Beginso template seed data (77 templates)

Files
- looks.ts            the 10 Looks (colours, fonts, shapes). Starting values: contrast-check before use.
- builders.ts         shared helpers and notes. Read the notes at the top.
- wave1Templates.ts   25 templates
- wave2Templates.ts   30 templates (current ones rebuilt)
- wave3Templates.ts   22 new templates
- allTemplates.ts     all 77 in one list
- check.ts            validation script (run with: npx tsx check.ts)
- TEMPLATE_CATALOGUE.md  names, categories, Looks, layouts, which current template each replaces

Checked here: unique slugs, label and headline limits, no repeated help lines, choice option counts,
no long flat pages, show-if targets exist, TypeScript strict type-check.
NOT checked here (needs the real repo): the real Template schema, brandingSchema, the real show-if format,
the contrast script on final colours, how each one looks on screen.

How to use
1. Give these files to your coding AI with AI_TEMPLATES_REBUILD_PROMPT.md. It wires them into the backend seed,
   maps `_showIf` to the real show-if shape, and runs brandingSchema and the contrast check over everything.
2. It must NOT write to the live database. The backend owner runs the sync script (dry run first, then --apply)
   after the code is merged and deployed. Take a backup of the templates collection first.
3. Review a few templates on screen (screenshots) before each wave is synced.
