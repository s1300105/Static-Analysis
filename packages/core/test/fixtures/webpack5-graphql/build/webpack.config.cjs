const path = require('node:path');

module.exports = {
  mode: 'production',
  entry: { main: './src/index.js' },
  devtool: false,
  output: { path: path.resolve(__dirname, 'dist'), filename: '[name].[contenthash:8].js', clean: true },
};
