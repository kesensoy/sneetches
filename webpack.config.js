const path = require('path');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    options: path.join(__dirname, './src/options.ts'),
    content: path.join(__dirname, './src/content.ts')
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
    })
  ],
  devtool: process.env.NODE_ENV === 'development' ? 'inline-source-map' : false
};
