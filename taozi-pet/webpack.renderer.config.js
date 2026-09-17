const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');

module.exports = (env, argv) => {
  // 开发/热重载用非阻塞检查，打包/生产用阻塞硬闸（类型错误则构建失败）
  const isDev = argv?.mode !== 'production';
  return {
    devtool: 'source-map',
    module: {
      rules: [
        { test: /\.tsx?$/, exclude: /node_modules/, use: [{ loader: 'ts-loader', options: { transpileOnly: true } }] },
        { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
        { test: /\.png$/i, type: 'asset/resource' },
      ],
    },
    plugins: [
      new MiniCssExtractPlugin({ filename: '[name].css' }),
      new ForkTsCheckerWebpackPlugin({ async: !isDev ? false : true }),
    ],
    resolve: { extensions: ['.ts', '.tsx', '.js', '.json'] },
  };
};