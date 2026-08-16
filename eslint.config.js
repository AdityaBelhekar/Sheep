import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier/flat';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.vite/**', '**/coverage/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
);
