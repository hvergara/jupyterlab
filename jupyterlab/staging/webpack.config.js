/*-----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

var plib = require('path');
var fs = require('fs-extra');
var Handlebars = require('handlebars');
var HtmlWebpackPlugin = require('html-webpack-plugin');
var webpack = require('webpack');
var DuplicatePackageCheckerPlugin = require('duplicate-package-checker-webpack-plugin');
var Visualizer = require('webpack-visualizer-plugin');

var Build = require('@jupyterlab/buildutils').Build;
var package_data = require('./package.json');

// Handle the extensions.
var jlab = package_data.jupyterlab;
var extensions = jlab.extensions;
var mimeExtensions = jlab.mimeExtensions;
var packageNames = Object.keys(mimeExtensions).concat(Object.keys(extensions));

// Ensure a clear build directory.
var buildDir = plib.resolve(jlab.buildDir);
if (fs.existsSync(buildDir)) {
  fs.removeSync(buildDir);
}
fs.ensureDirSync(buildDir);

// Build the assets
var extraConfig = Build.ensureAssets({
  packageNames: packageNames,
  output: jlab.outputDir
});

// Create the entry point file.
var source = fs.readFileSync('index.js').toString();
var template = Handlebars.compile(source);
var data = {
  jupyterlab_extensions: extensions,
  jupyterlab_mime_extensions: mimeExtensions
};
var result = template(data);

fs.writeFileSync(plib.join(buildDir, 'index.out.js'), result);
fs.copySync('./package.json', plib.join(buildDir, 'package.json'));
fs.copySync(
  plib.join(jlab.outputDir, 'imports.css'),
  plib.join(buildDir, 'imports.css')
);

// Set up variables for the watch mode ignore plugins
let watched = {};
let ignoreCache = Object.create(null);
Object.keys(jlab.watchedPackages).forEach(function(name) {
  if (name in watched) return;
  const localPkgPath = require.resolve(plib.join(name, 'package.json'));
  watched[name] = plib.dirname(localPkgPath);
});

/**
 * Sync a local path to a linked package path if they are files and differ.
 */
function maybeSync(localPath, name, rest) {
  const stats = fs.statSync(localPath);
  if (!stats.isFile(localPath)) {
    return;
  }
  const source = fs.realpathSync(plib.join(jlab.watchedPackages[name], rest));
  if (source === fs.realpathSync(localPath)) {
    return;
  }
  fs.watchFile(source, { interval: 500 }, function(curr) {
    if (!curr || curr.nlink === 0) {
      return;
    }
    try {
      fs.copySync(source, localPath);
    } catch (err) {
      console.error(err);
    }
  });
}

/**
 * A filter function set up to exclude all files that are not
 * in a package contained by the Jupyterlab repo
 */
function ignored(path) {
  path = plib.resolve(path);
  if (path in ignoreCache) {
    // Bail if already found.
    return ignoreCache[path];
  }

  // Limit the watched files to those in our local linked package dirs.
  let ignore = true;
  Object.keys(watched).some(name => {
    const rootPath = watched[name];
    const contained = path.indexOf(rootPath + plib.sep) !== -1;
    if (path !== rootPath && !contained) {
      return false;
    }
    const rest = path.slice(rootPath.length);
    if (rest.indexOf('node_modules') === -1) {
      ignore = false;
      maybeSync(path, name, rest);
    }
    return true;
  });
  ignoreCache[path] = ignore;
  return ignore;
}

// custom webpack plugin definitions.
// These can be removed the next time @jupyterlab/buildutils is published on npm
class FrontEndPlugin {
  constructor(buildDir, staticDir) {
    this.buildDir = buildDir;
    this.staticDir = staticDir;

    this._first = true;
  }

  apply(compiler) {
    compiler.hooks.afterEmit.tap('JupyterFrontEndPlugin', () => {
      // bail if no staticDir
      if (!this.staticDir) {
        return;
      }

      // ensure a clean static directory on the first emit
      if (this._first && fs.existsSync(this.staticDir)) {
        fs.removeSync(this.staticDir);
      }
      this._first = false;

      fs.copySync(this.buildDir, this.staticDir);
    });
  }
}

class FilterIgnoringWatchFileSystem {
  constructor(wfs, ignored) {
    this.wfs = wfs;
    // ignored should be a callback function that filters the build files
    this.ignored = ignored;
  }

  watch(files, dirs, missing, startTime, options, callback, callbackUndelayed) {
    const notIgnored = path => !this.ignored(path);

    const ignoredFiles = files.filter(ignored);
    const ignoredDirs = dirs.filter(ignored);

    const watcher = this.wfs.watch(
      files.filter(notIgnored),
      dirs.filter(notIgnored),
      missing,
      startTime,
      options,
      (
        err,
        filesModified,
        dirsModified,
        missingModified,
        fileTimestamps,
        dirTimestamps,
        removedFiles
      ) => {
        if (err) return callback(err);
        for (const path of ignoredFiles) {
          fileTimestamps.set(path, 1);
        }

        for (const path of ignoredDirs) {
          dirTimestamps.set(path, 1);
        }

        callback(
          err,
          filesModified,
          dirsModified,
          missingModified,
          fileTimestamps,
          dirTimestamps,
          removedFiles
        );
      },
      callbackUndelayed
    );

    return {
      close: () => watcher.close(),
      pause: () => watcher.pause(),
      getContextTimestamps: () => {
        const dirTimestamps = watcher.getContextTimestamps();
        for (const path of ignoredDirs) {
          dirTimestamps.set(path, 1);
        }
        return dirTimestamps;
      },
      getFileTimestamps: () => {
        const fileTimestamps = watcher.getFileTimestamps();
        for (const path of ignoredFiles) {
          fileTimestamps.set(path, 1);
        }
        return fileTimestamps;
      }
    };
  }
}

class FilterWatchIgnorePlugin {
  constructor(ignored) {
    this.ignored = ignored;
  }

  apply(compiler) {
    compiler.hooks.afterEnvironment.tap('FilterWatchIgnorePlugin', () => {
      compiler.watchFileSystem = new FilterIgnoringWatchFileSystem(
        compiler.watchFileSystem,
        this.ignored
      );
    });
  }
}

const plugins = [
  new DuplicatePackageCheckerPlugin({
    verbose: true,
    exclude(instance) {
      // ignore known duplicates
      return ['domelementtype', 'hash-base', 'inherits'].includes(
        instance.name
      );
    }
  }),
  new HtmlWebpackPlugin({
    chunksSortMode: 'none',
    template: plib.join('templates', 'template.html'),
    title: jlab.name || 'JupyterLab'
  }),
  new webpack.HashedModuleIdsPlugin(),

  // custom plugin for ignoring files during a `--watch` build
  new FilterWatchIgnorePlugin(ignored),
  // custom plugin that copies the assets to the static directory
  new FrontEndPlugin(buildDir, jlab.staticDir)
];

if (process.argv.includes('--analyze')) {
  plugins.push(new Visualizer());
}

module.exports = [
  {
    mode: 'development',
    entry: {
      main: ['whatwg-fetch', plib.resolve(buildDir, 'index.out.js')]
    },
    output: {
      path: plib.resolve(buildDir),
      publicPath: '{{page_config.fullStaticUrl}}/',
      filename: '[name].[chunkhash].js'
    },
    optimization: {
      splitChunks: {
        chunks: 'all'
      }
    },
    module: {
      rules: [
        { test: /\.css$/, use: ['style-loader', 'css-loader'] },
        { test: /\.md$/, use: 'raw-loader' },
        { test: /\.txt$/, use: 'raw-loader' },
        {
          test: /\.js$/,
          use: ['source-map-loader'],
          enforce: 'pre',
          // eslint-disable-next-line no-undef
          exclude: /node_modules/
        },
        { test: /\.(jpg|png|gif)$/, use: 'file-loader' },
        { test: /\.js.map$/, use: 'file-loader' },
        {
          test: /\.woff2(\?v=\d+\.\d+\.\d+)?$/,
          use: 'url-loader?limit=10000&mimetype=application/font-woff'
        },
        {
          test: /\.woff(\?v=\d+\.\d+\.\d+)?$/,
          use: 'url-loader?limit=10000&mimetype=application/font-woff'
        },
        {
          test: /\.ttf(\?v=\d+\.\d+\.\d+)?$/,
          use: 'url-loader?limit=10000&mimetype=application/octet-stream'
        },
        {
          test: /\.otf(\?v=\d+\.\d+\.\d+)?$/,
          use: 'url-loader?limit=10000&mimetype=application/octet-stream'
        },
        { test: /\.eot(\?v=\d+\.\d+\.\d+)?$/, use: 'file-loader' },
        {
          test: /\.svg(\?v=\d+\.\d+\.\d+)?$/,
          use: 'url-loader?limit=10000&mimetype=image/svg+xml'
        }
      ]
    },
    watchOptions: {
      poll: 333
    },
    node: {
      fs: 'empty'
    },
    bail: true,
    devtool: 'inline-source-map',
    externals: ['node-fetch', 'ws'],
    plugins,
    stats: {
      chunkModules: true
    }
  }
].concat(extraConfig);
