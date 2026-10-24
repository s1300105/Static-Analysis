const path = require('node:path');

module.exports = {
  mode: 'production',
  entry: { main: './src/index.js' },
  devtool: 'source-map',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].[contenthash:8].js',
    chunkFilename: '[name].[contenthash:8].js',
    clean: true,
  },
  optimization: {
    splitChunks: { chunks: 'all', minSize: 0 },
  },
};
