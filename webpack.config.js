const path = require('path');
const webpack = require('webpack');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (_env, argv) => {
  const mode = argv.mode === 'production' ? 'production' : 'development';
  const isProd = mode === 'production';

  return {
    mode,
    entry: {
      options: path.join(__dirname, './src/options.ts'),
      content: path.join(__dirname, './src/content-entry.ts'),
      'service-worker': path.join(__dirname, './src/service-worker.ts')
    },
    output: {
      path: path.join(__dirname, './build'),
      filename: '[name].js'
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
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
      extensions: ['.ts', '.js']
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
    devtool: isProd ? false : 'inline-source-map'
  };
};
