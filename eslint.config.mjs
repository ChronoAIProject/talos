import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts'],
    ignores: ['**/dist/**', '**/dist-runtime/**', '**/node_modules/**'],
    languageOptions: { parser },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-console': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error'
    }
  }
];
