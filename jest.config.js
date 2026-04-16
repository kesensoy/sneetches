/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testEnvironmentOptions: {
    url: 'http://localhost/'
  },
  testRegex: '(/__tests__/.*|(\\.|/).+[_.]test)\\.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
  moduleFileExtensions: ['ts', 'js'],
  setupFiles: [
    'jest-webextension-mock',
    './tests/chrome-storage.mock.ts',
    './tests/port.mock.ts',
    './tests/probe-silence.ts',
  ],
  globals: {
    __DEBUG__: true
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: false
    }]
  }
};
