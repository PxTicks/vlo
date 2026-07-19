import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import noIncompatibleTimelineTimeArithmetic from './eslint-rules/no-incompatible-timeline-time-arithmetic.js'

export default defineConfig([
  globalIgnores([
    'dist',
    'node_modules',
    'coverage',
    'test-results',
    'playwright-report',
    'playwright/.cache',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // UI-as-data ratchet (docs/extension-shell-surfaces-plan.md §3.6): new
      // menus must render through AppMenu with descriptor items so they join
      // the extensible menu catalogue. Unconverted legacy menus are exempted
      // below; shrink that list, never grow it.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@mui/material',
              importNames: ['Menu', 'MenuList'],
              message:
                'Render menus through AppMenu (features/extensions/menus) so they are descriptor-driven and extension-hookable. See docs/extension-shell-surfaces-plan.md §3.',
            },
          ],
          patterns: [
            {
              group: ['@mui/material/Menu', '@mui/material/MenuList'],
              message:
                'Render menus through AppMenu (features/extensions/menus) so they are descriptor-driven and extension-hookable. See docs/extension-shell-surfaces-plan.md §3.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'vlo-time-domains': {
        rules: {
          'no-incompatible-timeline-time-arithmetic':
            noIncompatibleTimelineTimeArithmetic,
        },
      },
    },
    rules: {
      'vlo-time-domains/no-incompatible-timeline-time-arithmetic': 'error',
    },
  },
  {
    // The descriptor renderer itself, plus legacy menus awaiting conversion
    // (waves 2-3 in docs/extension-shell-surfaces-plan.md §3.5).
    files: [
      'src/features/extensions/menus/AppMenu.tsx',
      'src/app/layout/ProjectSettingsMenu.tsx',
      'src/app/layout/RightSidebarPanel.tsx',
      'src/features/generation/GenerationPanel.tsx',
      'src/features/masks/MaskPanel.tsx',
      'src/features/masks/components/MaskEquationBuilder.tsx',
      'src/features/timeline/hooks/useTimelineMarkersClipOverlay.tsx',
      'src/features/transformations/components/TransformationPanel.tsx',
      'src/features/userAssets/AssetBrowser.tsx',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
])
