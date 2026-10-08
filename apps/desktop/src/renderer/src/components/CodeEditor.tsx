import { useEffect, useRef, type ReactElement } from 'react';
import type { monaco as Monaco } from './monaco';

type Editor = Monaco.editor.IStandaloneCodeEditor;

const themeFor = (): string =>
  document.documentElement.dataset['theme'] === 'dark' ? 'vs-dark' : 'vs';

/**
 * A Python editor.
 *
 * Monaco owns the text while it is being typed; `value` flows in only when it
 * differs from what the editor already holds — a run loaded from history, say —
 * so typing never fights a re-render for the cursor.
 */
export function CodeEditor({
  value,
  onChange,
  onRun,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter. */
  onRun: () => void;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  // The editor is created once; these keep its callbacks pointed at the
  // current render's handlers.
  const latest = useRef({ value, onChange, onRun });
  latest.current = { value, onChange, onRun };

  useEffect(() => {
    let disposed = false;
    let themeWatch: MutationObserver | undefined;

    void import('./monaco').then(({ monaco }) => {
      const element = host.current;
      if (disposed || !element) return;

      const created = monaco.editor.create(element, {
        value: latest.current.value,
        language: 'python',
        theme: themeFor(),
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        tabSize: 4,
        insertSpaces: true,
        renderLineHighlight: 'line',
        padding: { top: 8, bottom: 8 },
      });
      created.onDidChangeModelContent(() => {
        latest.current.onChange(created.getValue());
      });
      created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        latest.current.onRun();
      });
      editor.current = created;
      element.dataset['sheepEditor'] = 'ready';

      // The shell themes by an attribute on <html>; follow it.
      themeWatch = new MutationObserver(() => {
        monaco.editor.setTheme(themeFor());
      });
      themeWatch.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
    });

    return () => {
      disposed = true;
      themeWatch?.disconnect();
      editor.current?.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    const current = editor.current;
    if (current && current.getValue() !== value) current.setValue(value);
  }, [value]);

  return <div ref={host} className="lab__editor" data-sheep-editor="loading" />;
}
