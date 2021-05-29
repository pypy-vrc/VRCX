const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const {VueLoaderPlugin} = require('vue-loader');

module.exports = {
    entry: {
        app: ['./src/app.js', './src/app.scss'],
        vr: ['./src/vr.js', './src/vr.scss']
    },
    output: {
        filename: '[name].js',
        library: {
            type: 'window'
        }
    },
    module: {
        rules: [
            {
                test: /\.pug$/,
                oneOf: [
                    {
                        resourceQuery: /^\?vue/,
                        use: 'pug-plain-loader'
                    },
                    {
                        use: ['raw-loader', 'pug-plain-loader']
                    }
                ]
            },
            {
                test: /\.s?css$/,
                use: [MiniCssExtractPlugin.loader, 'css-loader', 'sass-loader']
            },
            {
                test: /\.ts$/,
                loader: 'ts-loader'
            },
            {
                test: /\.vue$/,
                loader: 'vue-loader',
                options: {
                    hotReload: false
                }
            },
            {
                test: /\.(eot|png|svg|ttf|woff)/,
                use: {
                    loader: 'url-loader',
                    options: {
                        limit: false,
                        name: 'assets/[name].[ext]'
                    }
                }
            }
        ]
    },
    resolve: {
        extensions: ['.css', '.js', '.scss', '.ts', '.vue'],
        alias: {
            vue: path.join(
                __dirname,
                './node_modules/vue/dist/vue.common.prod.js'
            )
        }
    },
    performance: {
        hints: false
    },
    devtool: 'inline-source-map',
    target: ['web', 'es2020'],
    stats: {
        preset: 'errors-only',
        builtAt: true,
        timings: true
    },
    plugins: [
        new VueLoaderPlugin(),
        new MiniCssExtractPlugin({
            filename: '[name].css'
        }),
        new HtmlWebpackPlugin({
            filename: 'index.html',
            template: './src/index.pug',
            inject: false,
            minify: false
        }),
        new HtmlWebpackPlugin({
            filename: 'vr.html',
            template: './src/vr.pug',
            inject: false,
            minify: false
        }),
        new CopyPlugin({
            patterns: [
                {
                    from: './images/',
                    to: './images/'
                }
            ]
        })
    ],
    optimization: {
        // minimize: true,
        minimizer: [
            new TerserPlugin({
                extractComments: false
            }),
            new CssMinimizerPlugin({
                minimizerOptions: {
                    preset: [
                        'default',
                        {
                            discardComments: {
                                removeAll: true
                            }
                        }
                    ]
                }
            })
        ]
    }
};
