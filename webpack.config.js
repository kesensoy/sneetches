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
                  // Tell Terser that calls to these functions have no
                  // observable side effects, so call sites can be
                  // deleted entirely — including their string-literal
                  // phase-name arguments. Combined with the
                  // `if (!__DEBUG__) return;` guard at the top of each
                  // function body, this produces zero bytes of probe
                  // code in the prod bundle.
                  //
                  // IMPORTANT: these names are keyed on the
                  // `import * as probe from './debug/probe';` form at
                  // the call site. If someone refactors to a named
                  // import (`import { mark, dump, reset } from ...`),
                  // these match nothing and the explicit pure_funcs
                  // safety net disappears. The `if (!__DEBUG__)` guard
                  // body-pruning still works even then, but the real
                  // canary is `npm run test:dce` — always re-run it
                  // after changing probe import shapes.
                  pure_funcs: [
                    'probe.mark',
                    'probe.dump',
                    'probe.reset'
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
