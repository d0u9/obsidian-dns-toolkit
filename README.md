# DnS Toolkit

An Obsidian plugin for rendering colon blocks delimited by `:::`.

Repository: [d0u9/obsidian-dns-toolkit](https://github.com/d0u9/obsidian-dns-toolkit)

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

Requires Node.js 18 or newer and npm.

```bash
npm install
npm run dev
```

Run checks and create a production bundle with:

```bash
npm run lint
npm run build
```

## Release

Releases are built by GitHub Actions. Before releasing, update the version in
`package.json`; the version script keeps `manifest.json` and `versions.json` in
sync:

```bash
npm version patch
git push origin main
git push origin --tags
```

The pushed version tag must exactly match the version in `manifest.json` (for
example, `0.1.1`, without a leading `v`). The release workflow runs lint and a
production build, generates build provenance, and creates a draft GitHub
Release containing `main.js`, `manifest.json`, and `styles.css`. Review the
release notes and assets on GitHub, then publish the draft.

For the workflow to create releases, configure the repository under
**Settings → Actions → General → Workflow permissions** to use **Read and write
permissions**.

The repository name includes the `obsidian-` prefix for discoverability. The
installed plugin ID remains `dns-toolkit`, and the user-facing name remains
**DnS Toolkit**.
