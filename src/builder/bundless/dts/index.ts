import { chalk, fsExtra, winPath } from '@umijs/utils';
import fs from 'fs';
import path from 'path';
import tsPathsTransformer from 'typescript-transform-paths';
import { CACHE_PATH } from '../../../constants';
import { getCache, logger } from '../../../utils';
import { getContentHash } from '../../utils';

/**
 * get parsed tsconfig.json for specific path
 */
export function getTsconfig(cwd: string) {
  // use require() rather than import(), to avoid jest runner to fail
  // ref: https://github.com/nodejs/node/issues/35889
  const ts: typeof import('typescript') = require('typescript');
  const tsconfigPath = ts.findConfigFile(cwd, ts.sys.fileExists);

  if (tsconfigPath) {
    const tsconfigFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(
      tsconfigFile.config,
      ts.sys,
      path.dirname(tsconfigPath),
    );
  }
}

/**
 * get declarations for specific files
 */
export default async function getDeclarations(
  inputFiles: string[],
  opts: { cwd: string },
) {
  const cache = getCache('bundless-dts');
  const enableCache = process.env.FATHER_CACHE !== 'none';
  const tscCacheDir = path.join(opts.cwd, CACHE_PATH, 'tsc');
  if (enableCache) {
    // make tsc cache dir
    fsExtra.ensureDirSync(tscCacheDir);
  }

  const output: { file: string; content: string; sourceFile: string }[] = [];
  // use require() rather than import(), to avoid jest runner to fail
  // ref: https://github.com/nodejs/node/issues/35889
  const ts: typeof import('typescript') = require('typescript');
  const tsconfig = getTsconfig(opts.cwd);

  if (tsconfig) {
    // check tsconfig error
    /* istanbul ignore if -- @preserve */
    if (tsconfig.errors.length) {
      throw new Error(
        `Error parsing tsconfig.json content: ${chalk.redBright(
          ts.flattenDiagnosticMessageText(tsconfig.errors[0].messageText, '\n'),
        )}`,
      );
    }

    // warn if noEmit is false
    /* istanbul ignore if -- @preserve */
    if (tsconfig.options.declaration && tsconfig.options.noEmit === true) {
      logger.warn(
        'tsconfig.json `noEmit` is true, will not emit declaration files!',
      );

      return output;
    }

    // enable declarationMap by default in development mode
    if (
      process.env.NODE_ENV === 'development' &&
      tsconfig.options.declaration &&
      tsconfig.options.declarationMap !== false
    ) {
      tsconfig.options.declarationMap = true;
    }

    // remove paths which out of cwd, to avoid transform to relative path by ts-paths-transformer
    Object.keys(tsconfig.options.paths || {}).forEach((item) => {
      const pathAbsTarget = path.resolve(
        tsconfig.options.pathsBasePath as string,
        tsconfig.options.paths![item][0],
      );

      if (!winPath(pathAbsTarget).startsWith(`${winPath(opts.cwd)}/`)) {
        delete tsconfig.options.paths![item];
        logger.debug(
          `Remove ${item} from tsconfig.paths, because it's out of cwd.`,
        );
      }
    });
    // enable incremental for cache
    if (enableCache && typeof tsconfig.options.incremental === 'undefined') {
      tsconfig.options.incremental = true;
      tsconfig.options.tsBuildInfoFile = path.join(
        tscCacheDir,
        'tsc.tsbuildinfo',
      );
    }

    const tsHost = ts.createIncrementalCompilerHost(tsconfig.options);
    const cacheKeys = inputFiles.reduce<Record<string, string>>(
      (ret, file) => ({
        ...ret,
        // format: {path:mtime:config}
        [file]: [
          file,
          getContentHash(fs.readFileSync(file, 'utf-8')),
          JSON.stringify(tsconfig.options),
        ].join(':'),
      }),
      {},
    );
    const cacheRets: Record<string, typeof output> = {};

    tsHost.writeFile = (fileName, content, _a, _b, sourceFiles) => {
      const sourceFile = sourceFiles?.[0].fileName;

      if (fileName === tsconfig.options.tsBuildInfoFile) {
        // save incremental cache
        fsExtra.writeFileSync(tsconfig.options.tsBuildInfoFile, content);
      } else if (sourceFile) {
        // write d.ts & d.ts.map and save cache
        const ret = {
          file: path.basename(fileName),
          content,
          sourceFile,
        };

        // only collect dts for input files, to avoid output error in watch mode
        // ref: https://github.com/umijs/father-next/issues/43
        if (inputFiles.includes(sourceFile)) {
          const index = output.findIndex(
            (out) => out.file === ret.file && out.sourceFile === ret.sourceFile,
          );
          if (index > -1) {
            output.splice(index, 1, ret);
          } else {
            output.push(ret);
          }
        }

        // group cache by file (d.ts & d.ts.map)
        // always save cache even if it's not input file, to avoid cache miss
        // because it probably can be used in next bundless run
        const cacheKey =
          cacheKeys[sourceFile] ||
          [
            sourceFile,
            getContentHash(fs.readFileSync(sourceFile, 'utf-8')),
            JSON.stringify(tsconfig.options),
          ].join(':');

        cacheRets[cacheKey] ??= [];
        cacheRets[cacheKey].push(ret);
      }
    };

    // use cache first
    inputFiles.forEach((file) => {
      const cacheRet = cache.getSync(cacheKeys[file], '');
      if (cacheRet) {
        output.push(...cacheRet);
      }
    });

    const incrProgram = ts.createIncrementalProgram({
      rootNames: inputFiles,
      options: tsconfig.options as any,
      host: tsHost,
    });

    // using ts-paths-transformer to transform tsconfig paths to relative path
    // reason: https://github.com/microsoft/TypeScript/issues/30952
    // ref: https://www.npmjs.com/package/typescript-transform-paths
    const result = incrProgram.emit(undefined, undefined, undefined, true, {
      afterDeclarations: [
        tsPathsTransformer(
          incrProgram.getProgram(),
          { afterDeclarations: true },
          // specific typescript instance, because this plugin is incompatible with typescript@4.9.x currently
          // but some project may declare typescript and some dependency manager will hoist project's typescript
          // rather than father's typescript for this plugin
          { ts },
        ),
      ],
    });

    // check compile error
    // istanbul-ignore-if
    if (result.diagnostics.length) {
      result.diagnostics.forEach((d) => {
        const loc = ts.getLineAndCharacterOfPosition(d.file!, d.start!);
        const rltPath = winPath(path.relative(opts.cwd, d.file!.fileName));
        const errMsg = ts.flattenDiagnosticMessageText(d.messageText, '\n');

        logger.error(
          `${chalk.blueBright(rltPath)}:${
            // correct line number & column number, ref: https://github.com/microsoft/TypeScript/blob/93f2d2b9a1b2f8861b49d76bb5e58f6e9f2b56ee/src/compiler/tracing.ts#L185
            `${chalk.yellow(loc.line + 1)}:${chalk.yellow(loc.character + 1)}`
          } - ${chalk.gray(`TS${d.code}:`)} ${errMsg}`,
        );
      });
      throw new Error('Declaration generation failed.');
    }

    // save cache
    Object.keys(cacheRets).forEach((key) => cache.setSync(key, cacheRets[key]));
  }

  return output;
}
