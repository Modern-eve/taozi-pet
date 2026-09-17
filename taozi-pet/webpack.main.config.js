const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');

module.exports = (env, argv) => {
  // 开发/热重载用非阻塞检查，打包/生产用阻塞硬闸（类型错误则构建失败）
  const isDev = argv?.mode !== 'production';
  return {
    entry: './src/main.ts',
    target: 'electron-main',
    devtool: 'source-map',
    module: {
      rules: [
        { test: /\.tsx?$/, exclude: /node_modules/, use: [{ loader: 'ts-loader', options: { transpileOnly: true } }] },
        { test: /\.png$/i, type: 'asset/resource' },
      ],
    },
    plugins: [new ForkTsCheckerWebpackPlugin({ async: !isDev ? false : true })],
    resolve: { extensions: ['.ts', '.tsx', '.js', '.json'] },
    externals: { 'uiohook-napi': 'commonjs2 uiohook-napi' },
  };
};