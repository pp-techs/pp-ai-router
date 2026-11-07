# pp-ai-router logo guide

**Idea:** one input ring fans out at exact 45° to three provider dots: one endpoint, many upstreams.

## Files

| Need                       | File                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| Default (light background) | `lockups/pp-ai-router-horizontal.svg`, `-stacked.svg`                     |
| Dark background            | `lockups/*-on-dark.svg`                                                   |
| One colour                 | `lockups/*-black.svg`, `*-white.svg`, `*-mono-1a1915.svg`                 |
| Symbol only                | `symbol/pp-ai-router-symbol.svg` (+ `-on-dark`, black, white, mono)       |
| Below 32 px                | `symbol/pp-ai-router-symbol-small*.svg` (heavier cut)                     |
| Favicon / app icon         | `apps/web/public/` (`favicon.svg`, `favicon.ico`, `apple-touch-icon.png`) |

## Colour

| Role                   | HEX       | RGB         | CMYK (approx., confirm with printer) |
| ---------------------- | --------- | ----------- | ------------------------------------ |
| Ink                    | `#1A1915` | 26 25 21    | 0 4 19 90                            |
| Signal (provider dots) | `#F2542D` | 242 84 45   | 0 65 90 5                            |
| Paper                  | `#FAF9F5` | 250 249 245 | 0 0 2 2                              |

Contrast: Ink on white 16:1; Signal on white 3.4:1, Signal on Ink 5.1:1. Signal is for the dots and large graphics only, never body text. Ink matches the admin UI's `--primary` neutral.

## Type

Wordmark: Geist SemiBold (600), lowercase `pp-ai-router`, tracking −1.5 %, converted to outlines (SIL OFL, logo use permitted). Same family as the admin UI headings.

## Clear space and size

- Clear space: one dot diameter (`d` = 40/256 of symbol canvas) on all sides.
- Minimum: symbol 16 px (use the small cut under 32 px); horizontal lockup 120 px wide; stacked lockup 80 px wide.

## Do not

- Recolour the dots or ring, or use more than the two brand colours.
- Rotate, skew, outline, add shadows or gradients.
- Change spoke angles or dot sizes; use the small cut at large sizes.
- Place Signal artwork on orange/red photos; use the one-colour white version.
- Retype the wordmark in another font.

## Open items

- No trademark or reverse-image search done. The ring-and-branch form is a common pictogram family; get a professional check before registering.
- Pantone and print CMYK values are not matched.
