import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.vite/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // 前端方案 §4.1：fetch 只允许出现在 lib/api/client.ts；alert/confirm 一律用 toast
      'no-restricted-globals': ['error', 'fetch', 'alert', 'confirm'],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/lib/api/client.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
