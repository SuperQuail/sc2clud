import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.vite/**', '**/.tmp-*/**', '**/tmp/**', '**/preview-dist/**'] },
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
    // 控件必须用房子里的组件：手写 <button> 这类元素一律失败（src/ui 是封装它们的唯一地方）
    files: ['src/**/*.tsx'],
    ignores: ['src/ui/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['button', 'input', 'select', 'textarea', 'table', 'dialog'].map((el) => ({
          selector: "JSXOpeningElement[name.name='" + el + "']",
          message:
            '不要手写 <' + el + '>：用 Ring UI 的组件，或在 src/ui/ 里做一次封装后复用。',
        })),
      ],
    },
  },
  {
    files: ['src/lib/api/client.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
