// A module's text, as Vite imports it with ?raw (themes.css, for the window's colours).
declare module '*?raw' {
  const text: string
  export default text
}
