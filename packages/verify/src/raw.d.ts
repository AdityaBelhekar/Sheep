/** Python sources are bundled as text and run inside the sandbox. */
declare module '*.py?raw' {
  const source: string;
  export default source;
}
