import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Migrated from tslint.yaml
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'interface',
          format: ['PascalCase'],
          custom: {
            regex: '^I[A-Z]',
            match: false,
          },
        },
      ],
      'no-console': 'off',
      quotes: ['error', 'single', { avoidEscape: true }],
      // Allow unused vars that start with _
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  eslintConfigPrettier,
  {
    // scripts/ is the dev-tooling tree (probe-run, etc.). It interops with
    // CJS-first packages (chrome-remote-interface) via `require()`, and its
    // skeletons can land before the symbols they declare are wired up. Loosen
    // the two rules that collide with that workflow; everything else still
    // applies.
    files: ['scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'build/', 'dist/', '*.js', '*.mjs', 'webpack.config.js', 'jest.config.js'],
  }
);
