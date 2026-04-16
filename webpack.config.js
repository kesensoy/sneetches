const path = require('path');
const webpack = require('webpack');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (_env, argv) => {
  const mode = argv.mode === 'production' ? 'production' : 'development';
  const isProd = mode === 'production';

  return {
    mode,
    entry: {
      options: path.join(__dirname, './src/options.ts'),
      content: path.join(__dirname, './src/content.ts'),
      'service-worker': path.join(__dirname, './src/service-worker.ts')
    },
    output: {
      path: path.join(__dirname, './build'),
      filename: '[name].js'
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: {
              transpileOnly: true
            }
          },
          exclude: /node_modules/
        }
      ]
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js']
    },
    plugins: [
      new CleanWebpackPlugin(),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: 'src',
            globOptions: {
              ignore: ['**/*.js', '**/*.ts', '**/.DS_Store']
            }
          }
        ]
      }),
      new webpack.DefinePlugin({
        __DEBUG__: JSON.stringify(!isProd)
      })
    ],
    optimization: isProd
      ? {
          minimize: true,
          minimizer: [
            new TerserPlugin({
              terserOptions: {
                compress: {
                  // Tell Terser that calls to these functions / methods
                  // have no observable side effects, so call sites can
                  // be deleted entirely — including their string-literal
                  // phase-name arguments. Combined with the
                  // `if (!__DEBUG__) return;` guard at the top of each
                  // method body, this produces zero bytes of probe
                  // code in the prod bundle.
                  //
                  // IMPORTANT: these names are keyed on the
                  // `import * as probe from './debug/probe';` form at
                  // the call site AND on the `frame.mark` / `frame.dump`
                  // method names used by the per-scan frame API. If
                  // someone refactors to named imports
                  // (`import { newFrame } from ...`) or renames the
                  // local frame variable (e.g. `f.mark` instead of
                  // `frame.mark`), these patterns match nothing and
                  // the explicit pure_funcs safety net disappears. The
                  // `if (!__DEBUG__)` guard body-pruning still works
                  // even then, but the real canary is `npm run test:dce`
                  // — always re-run it after changing probe import or
                  // usage shapes.
                  pure_funcs: [
                    'probe.newFrame',
                    'frame.mark',
                    'frame.dump'
                  ],
                  passes: 2
                }
              }
            })
          ]
        }
      : undefined,
    devtool: isProd ? false : 'inline-source-map'
  };
};
