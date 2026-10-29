// A fixture for fabrica/no-colour-literals (scripts/lint-colour-literals.test.ts): each line below
// writes a colour the rule refuses. It is outside the renderer, so the lint step leaves it be.
export const hex = '#1A1D21'
export const shortHex = 'border-color: #fff'
export const alpha = '#05060BCC'
export const rgb = 'rgba(255, 46, 155, 0.24)'
export const oklch = 'oklch(0.86 0.17 125)'
export const arbitrary = 'bg-[#ff2e9b] p-12'
export const palette = 'bg-white text-gray-800'
export const variant = 'flex hover:bg-gray-700'
export const opacity = 'text-sky-500/50'
export const template = `color: hsl(${120} 50% 50%)`
