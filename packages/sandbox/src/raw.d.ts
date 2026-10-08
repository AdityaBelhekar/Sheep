/** Python sources are bundled as text and written to disk beside the jail. */
declare module '*.py?raw' {
  const source: string;
  export default source;
}
