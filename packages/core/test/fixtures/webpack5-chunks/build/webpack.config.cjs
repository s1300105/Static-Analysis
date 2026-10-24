const path = require('node:path');

module.exports = {
  mode: 'production',
  entry: { main: './src/index.js' },
  devtool: 'source-map',
  output: {
    path: path.resolve(__dirname, 'dist'),
    publicPath: 'https://cdn.example.com/assets/',
    filename: '[name].[contenthash:8].js',
    chunkFilename: '[name].[contenthash:8].chunk.js',
    clean: true,
  },
};
