/** The reproduction script is bundled as text and written into every bundle. */
declare module '*.py?raw' {
  const source: string;
  export default source;
}
