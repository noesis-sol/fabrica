import { Order } from 'effect'

// The order the tickets ref sorts text by (spec §11.7): code point by code point, so it is the same
// in every language reading the files. JavaScript's own `<` compares UTF-16 code units, which puts a
// character past the Basic Multilingual Plane before U+E000–U+FFFF.

/** Text in code point order. */
export const CodePoints: Order.Order<string> = Order.make((self, that) => {
  let i = 0
  let j = 0
  while (i < self.length && j < that.length) {
    const a = self.codePointAt(i) ?? 0
    const b = that.codePointAt(j) ?? 0
    if (a !== b) return a < b ? -1 : 1
    i += a > 0xffff ? 2 : 1
    j += b > 0xffff ? 2 : 1
  }
  const restSelf = self.length - i
  const restThat = that.length - j
  return restSelf === restThat ? 0 : restSelf < restThat ? -1 : 1
})

/** `texts` sorted in code point order, each once. */
export const sortedUnique = <A extends string>(texts: Iterable<A>): Array<A> =>
  [...new Set(texts)].sort((a, b) => CodePoints(a, b))
