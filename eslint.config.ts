import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  ignores: ['data/**', 'coverage/**'],
  rules: {
    'antfu/no-top-level-await': 'off',
    'no-console': 'off',
    'node/prefer-global/process': 'off',
  },
})
