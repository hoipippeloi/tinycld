# Help topic images: how a package ships them

Status: decided 2026-10-21. Needs sign-off before the PR merges (core change, requested by the Books spec).

## Question

How does a package's `help/*.md` reference an image stored in its own `help/` directory so that it renders on web and native, in light and dark, and does not leak a hostname or filesystem path?

## Options

1. **Copy images to a public dir** (`public/help/<slug>/...`) and reference an absolute URL. Rejected: web only. Native has no `public/` dir, and the URL would need a hostname.
2. **Inline images as base64 in the generated file.** Rejected: bloats `package-help.ts`, which is parsed on every launch, and the images cannot be lazy-loaded.
3. **Static `require()` map emitted by the generator (chosen).** Metro treats `.png/.jpg/.jpeg/.webp/.gif` as assets natively, hashes them on export, and handles web and native alike (the `require()` value differs per platform; see below). The `package.json` `exports` map is not involved, because the generated file requires the files by relative path and Metro already watches every workspace member.

## Decision

- The generator writes `export const helpImages: Record<string, number | string | { uri: string }>` into `lib/generated/package-help.ts`. Key: `<pkgSlug>/<path relative to help/>`, for example `books/images/invoices-1.png`. The value is what `require()` yields: an asset id on native (resolved with `Image.resolveAssetSource`), and `{ uri, width, height }` on web, where react-native-web has no `Image.resolveAssetSource`.
- Markdown references are relative to `help/`: `![alt](images/invoices-1.png)`. A leading `./` is allowed. Absolute URLs (`https:`, `data:`, `/x`) pass through untouched. Any `..` segment, or a reference to a missing file, fails generation.
- Dark mode: if `x.dark.png` ships next to `x.png`, the renderer uses it when the resolved app theme is dark. Authors write only `x.png`.
- Resolution happens in `HelpTopicView` through the existing `MarkdownRenderer` `transformImageUri` prop. `MarkdownRenderer` itself does not change.
- Search ignores image URLs but still matches alt text.
- Screenshot generation is a separate Playwright-driven CLI (contract in `tinycld/docs/packages.md`). It is out of scope for this change.
