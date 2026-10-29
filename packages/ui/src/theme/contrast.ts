import { Option } from 'effect'

// The contrast check of themes.css (spec §18.2, H63): each theme's text and status colours against
// the surfaces they're drawn on, and its ink against the fills it's drawn on, by WCAG 2's contrast
// ratio. Colours are read from themes.css's text; it writes them as hex or oklch().

/** A colour as linear-light sRGB channels, each 0 to 1. */
export interface LinearRgb {
  readonly red: number
  readonly green: number
  readonly blue: number
}

/** WCAG AA's least contrast for normal text. */
export const aaNormalText = 4.5

/** The variables drawn as text, the surfaces under them, and the fills under --ink (Appendix A.4). */
export const textVariables = ['fg', 'muted', 'c1', 'c2', 'c3', 'c4', 'c5']
export const surfaceVariables = ['bg', 'side', 'panel']
export const fillVariables = ['c1', 'c2', 'c3', 'c4', 'c5']

/** A text variable over a background variable, and their contrast. */
export interface ContrastPair {
  readonly text: string
  readonly background: string
  readonly ratio: number
}

const linearOfGamma = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4

const clip = (channel: number): number => Math.min(1, Math.max(0, channel))

const ofHex = (digits: string): LinearRgb => {
  const value = Number.parseInt(digits, 16)
  return {
    red: linearOfGamma(((value >> 16) & 0xff) / 255),
    green: linearOfGamma(((value >> 8) & 0xff) / 255),
    blue: linearOfGamma((value & 0xff) / 255),
  }
}

/** OKLCH to linear sRGB by Björn Ottosson's OKLab matrices, clipped to sRGB's gamut. */
const ofOklch = (lightness: number, chroma: number, hue: number): LinearRgb => {
  const a = chroma * Math.cos((hue * Math.PI) / 180)
  const b = chroma * Math.sin((hue * Math.PI) / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    red: clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    green: clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    blue: clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

const hexPattern = /^#([0-9a-f]{6})$/i
const oklchPattern = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/

/** The colour `text` writes, when it is an opaque hex or oklch() colour. */
export const parseColour = (text: string): Option.Option<LinearRgb> => {
  const trimmed = text.trim()
  const hex = hexPattern.exec(trimmed)
  if (hex?.[1] !== undefined) {
    return Option.some(ofHex(hex[1]))
  }
  const oklch = oklchPattern.exec(trimmed)
  if (oklch !== null) {
    return Option.some(
      ofOklch(Number(oklch[1]), Number(oklch[2]), Number(oklch[3])),
    )
  }
  return Option.none()
}

/** WCAG 2's relative luminance. */
export const relativeLuminance = ({ red, green, blue }: LinearRgb): number =>
  0.2126 * red + 0.7152 * green + 0.0722 * blue

/** WCAG 2's contrast ratio of two colours, 1 to 21. */
export const contrastRatio = (first: LinearRgb, second: LinearRgb): number => {
  const [one, other] = [relativeLuminance(first), relativeLuminance(second)]
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05)
}

/** Each theme of `css` (themes.css's text), by its data-theme name, with its variables' values. */
export const themeVariables = (
  css: string,
): ReadonlyMap<string, ReadonlyMap<string, string>> =>
  new Map(
    Array.from(
      css.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g),
      ([, name = '', body = '']) =>
        [
          name,
          new Map(
            Array.from(
              body.matchAll(/--([\w-]+):\s*([^;]+);/g),
              ([, variable = '', value = '']) =>
                [variable, value.trim()] as const,
            ),
          ),
        ] as const,
    ),
  )

/** The pairs a theme's contrast is checked on: every text on every surface, and ink on every
 *  fill. A variable missing or not an opaque colour is named in `unreadable`. */
export const themePairs = (
  variables: ReadonlyMap<string, string>,
): {
  readonly pairs: ReadonlyArray<ContrastPair>
  readonly unreadable: ReadonlyArray<string>
} => {
  const colourOf = (variable: string): Option.Option<LinearRgb> =>
    Option.flatMap(Option.fromUndefinedOr(variables.get(variable)), parseColour)
  const pair = (text: string, background: string): Array<ContrastPair> =>
    Option.match(Option.all([colourOf(text), colourOf(background)]), {
      onNone: () => [],
      onSome: ([foreground, behind]) => [
        { text, background, ratio: contrastRatio(foreground, behind) },
      ],
    })
  return {
    pairs: [
      ...textVariables.flatMap(text =>
        surfaceVariables.flatMap(background => pair(text, background)),
      ),
      ...fillVariables.flatMap(fill => pair('ink', fill)),
    ],
    unreadable: [
      ...new Set([...textVariables, ...surfaceVariables, 'ink']),
    ].filter(variable => Option.isNone(colourOf(variable))),
  }
}
