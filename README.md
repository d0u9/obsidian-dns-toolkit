# DnS Toolkit

An Obsidian plugin for rendering colon blocks delimited by `:::`.

## Syntax

```markdown
::: note Optional title

Markdown content goes here. **Formatting** and lists are supported.

:::
```

Blank lines after the opening delimiter and before the closing delimiter are
recommended because they let Obsidian parse the body as full block Markdown.
The renderer also accepts compact containers without those blank lines.

The first word after the opening delimiter is the container type. Editorial
styles matching the Writing style guide are included for `lead`, `epigraph`,
`poem`, `aside`, `imgcap`, and `compnote`. Unknown types use a generic accented
container. Every type is exposed as a `data-type` attribute for custom CSS.

Containers are rendered in Reading view. Use the **Insert custom container**
command to wrap selected text or insert a new container.

## Development

Requires Node.js 18 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

Run checks and create a production bundle with:

```bash
pnpm lint
pnpm build
```
