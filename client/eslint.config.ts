import { globalIgnores } from 'eslint/config'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import pluginVitest from '@vitest/eslint-plugin'
import pluginOxlint from 'eslint-plugin-oxlint'
import skipFormatting from 'eslint-config-prettier/flat'

// To allow more languages other than `ts` in `.vue` files, uncomment the following lines:
// import { configureVueProject } from '@vue/eslint-config-typescript'
// configureVueProject({ scriptLangs: ['ts', 'tsx'] })
// More info at https://github.com/vuejs/eslint-config-typescript/#advanced-setup

export default defineConfigWithVueTs(
  {
    name: 'app/files-to-lint',
    files: ['**/*.{vue,ts,mts,tsx}'],
  },

  globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/coverage/**', 'public/**', '**/dev-dist/**']),

  ...pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,

  {
    ...pluginVitest.configs.recommended,
    files: ['src/**/__tests__/**', 'src/**/*.{test,spec}.ts'],
  },

  {
    files: ['src/components/ui/**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },

  {
    files: ['src/**/*.{vue,ts,mts,tsx}'],
    ignores: ['src/lib/clipboard.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name='clipboard'][object.name='navigator'], MemberExpression[property.value='clipboard'][object.name='navigator'], MemberExpression[property.name='clipboard'][object.property.name='navigator'], MemberExpression[property.value='clipboard'][object.property.name='navigator']",
          message: "Use copyToClipboard from '@/lib/clipboard' so copy actions work on HTTP/self-hosted origins.",
        },
        {
          selector:
            "CallExpression[callee.property.name='execCommand'][arguments.0.value='copy'], CallExpression[callee.property.value='execCommand'][arguments.0.value='copy']",
          message: "Use copyToClipboard from '@/lib/clipboard' instead of adding another copy fallback.",
        },
      ],
    },
  },

  ...pluginOxlint.buildFromOxlintConfigFile('.oxlintrc.json'),

  skipFormatting,
)
