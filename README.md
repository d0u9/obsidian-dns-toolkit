# DnS Toolkit

An Obsidian plugin for rendering colon blocks delimited by `:::`.

Repository: [d0u9/obsidian-dns-toolkit](https://github.com/d0u9/obsidian-dns-toolkit)

## Syntax

```markdown
::: note Optional title

Markdown content goes here. **Formatting** and lists are supported.

:::
```

The brace section takes any `key=value` pair and `.class` shorthands:

```markdown
::: aside{width=60% align=center .wide} Optional title
```

`height`, `width`, `max-width` and `min-height` must be CSS lengths and become
inline styles, `align` accepts the four CSS keywords, a `.class` becomes
`dns-x-<name>`, and every other pair becomes a `data-<key>` attribute to style
from a snippet. A longer fence closes only on a fence at least as long, so
blocks can nest:

```markdown
:::: aside

::: poem
An inner block.
:::

::::
```

Typing an opening delimiter suggests the supported types, and Live Preview
styles the lines a block spans so its shape is visible while writing. Source
mode is left as raw text. An opening
delimiter that is never closed is marked in both views.

Blank lines after the opening delimiter and before the closing delimiter are
recommended because they let Obsidian parse the body as full block Markdown.
The renderer also accepts compact containers without those blank lines.

`lead`, `epigraph`, `poem`, and `aside` may also hold blank lines between their
own paragraphs. Obsidian renders such a body as several sections, so those
blocks are styled in place instead of being wrapped, and the outer spacing goes
to the first and last paragraph that shows text.

The first word after the opening delimiter is the container type. Editorial
styles matching the Writing style guide are included for `lead`, `epigraph`,
`poem`, `aside`, `imgcap`, `compnote`, `center`, and `spacer`. Use `center` to
center the block's contents and an empty `spacer` block to add vertical space.
Unknown types use a generic accented container. Every type is exposed as a
`data-type` attribute for custom CSS.

Add a fixed or relative block height with a `height` attribute. Supported units
are `px`, `rem`, `em`, `vh`, `vw`, `vmin`, `vmax`, and `%`:

```markdown
:::center{height=120px}

Centered content

:::

:::spacer{height=5rem}
:::
```

An `imgcap` block may mix paragraphs and lists. Lists keep the caption's font,
colour, and line height, and only add the indentation their markers need:

```markdown
:::imgcap
Sample photograph from this site

1. img1 is test
2. img2 is test
:::
```

Containers are rendered in Reading view. Use the **Insert custom container**
command to wrap selected text or insert a new container.

## Page typography

Reading and editing views can each override the font stack, font size, line
width, letter and word spacing, line height, and paragraph spacing. A sample
paragraph at the top of the section takes the values live, so a slider can be
judged without closing the settings pane. Line width applies where the theme
honours Obsidian's readable line length.

## Folder publishing

The optional desktop-only folder publishing feature copies one direct
subfolder, such as `publish/02`, to a configured folder outside the vault.
Configure and enable it under **Settings → DnS Toolkit → Folder publishing**,
then run **Publish folder to final publishing folder**. A destination path
copied from a terminal may arrive shell-escaped or quoted; the setting strips
that so the path still points at the real folder. The searchable picker
is populated from the source folder each time the command runs.

The selected top-level folder name is preserved. If the destination already
exists, the command asks for confirmation and safely replaces it after the new
copy has completed. The confirmation lists every file that will be added,
modified, or removed; selecting one shows the current destination and what is
about to be published side by side. Either version can be chosen for the whole
file, or one side at a time for each run of changed lines, in which case the
file is published as a merge of both. A modified file can also be pulled the
other way: **Also update the vault file** writes the same result back into the
note through Obsidian, so a change made at the destination — a flipped
frontmatter field, a corrected caption — stops coming back as a diff. Pressing Escape there returns to the list
rather than closing the dialog. Each change can be unchecked to
keep the destination version of that file, and the remaining changes are still
applied in a single atomic replacement. Images are compared side by side with
their dimensions and file size instead of as text. Symbolic links are rejected. This feature reads only the
configured source folder and writes only to the external destination selected
by the user; it makes no network requests. The destination sits outside the
vault, so it is reached through Node's file system API rather than the vault
API, guarded by a desktop check and by validation that the source stays inside
the vault and the destination stays outside it. Pulling a change back the other
way goes through the vault API instead, so Obsidian sees it.

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
