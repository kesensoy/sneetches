/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testEnvironmentOptions: {
    url: 'http://localhost/'
  },
  testRegex: '(/__tests__/.*|(\\.|/).+[_.]test)\\.(jsx?|tsx?)$',
  testPathIgnorePatterns: ['/node_modules/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  setupFiles: ['jest-webextension-mock', './tests/chrome-storage.mock.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: false
    }]
  }
};
