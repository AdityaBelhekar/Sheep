/**
 * Monaco, assembled by hand.
 *
 * The bare editor API plus Python and the handful of editing features a script
 * needs — not `editor.main`, which registers every language and four language
 * servers. Imported dynamically by `CodeEditor`, so none of it is loaded until
 * the Lab is opened.
 */
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/comment/browser/comment';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/indentation/browser/indentation';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';

// A bundled worker, served from the app itself: the content-security policy
// allows scripts from nowhere else.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };
