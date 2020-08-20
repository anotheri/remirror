/**
 * @packageDocumentation
 *
 * This file was originally sourced from
 * [here](https://github.com/microsoft/TypeScript-Website/blob/d4c638ffb113ad0b91f0614569b7e2b6882ad803/packages/sandbox/src/typeAcquisition.ts)
 * and is governed by the [MIT
 * license](https://github.com/microsoft/TypeScript-Website/blob/d4c638ffb113ad0b91f0614569b7e2b6882ad803/LICENSE-CODE).
 *
 * - Used with permission.
 * - Modifications have been made.
 */

import { compressToUTF16, decompressFromUTF16 } from 'lz-string';

import {
  createModuleReferenceId,
  mapModuleNameToModule,
  mapRelativePath,
  parseFileForModuleReferences,
} from '../playground-utils';

/**
 * The type definitions that can be used for this file. Null is the value when a
 * failure occurs.
 */
export interface TypeDefinitions {
  [name: string]: string | { types: { ts: string } } | null;
}

interface PseudoGlobal {
  __typeDefinitions: TypeDefinitions;
  __dtsCache: DtsCache;
}

// The global object in the current environment.
const pseudoGlobal: PseudoGlobal = ((typeof globalThis !== 'undefined'
  ? globalThis
  : window || {}) as unknown) as PseudoGlobal;
pseudoGlobal.__typeDefinitions = {};

/**
 * Type Defs we've already got, and nulls when something has failed. This is to
 * make sure that it doesn't infinite loop.
 */
export const acquiredTypeDefinitions: TypeDefinitions = pseudoGlobal.__typeDefinitions;

/**
 * `.d.ts` file contents for a particular path (e.g.
 * `@remirror/core/index.d.ts`)
 */
export const dtsCache: DtsCache = {};
pseudoGlobal.__dtsCache = dtsCache;

export type AddLibraryToRuntime = (code: string, path: string) => void;
export interface DtsCache {
  [module: string]: { [path: string]: string };
}

/**
 * Create the module url which relies on algolia.
 */
function moduleJsonUrl(name: string) {
  return `https://ofcncog2cu-dsn.algolia.net/1/indexes/npm-search/${encodeURIComponent(
    name,
  )}?attributes=types&x-algolia-agent=Algolia%20for%20vanilla%20JavaScript%20(lite)%203.27.1&x-algolia-application-id=OFCNCOG2CU&x-algolia-api-key=f54e21fa3a2a0160595bb058179bfb1e`;
}

/**
 * Create a URL for `unpkg.com`.
 */
function unpkgUrl(name: string, path: string) {
  return `https://www.unpkg.com/${encodeURIComponent(name)}/${encodeURIComponent(path)}`;
}

/**
 * Create the URL to the package.json file.
 */
function packageJsonUrl(name: string) {
  return unpkgUrl(name, 'package.json');
}

/**
 * Log an error to the console.
 */
const errorMessage = (msg: string, response: any) => {
  console.error(
    `${msg} - will not try again in this session`,
    response.status,
    response.statusText,
    response,
  );
};

/**
 * Takes an initial module name and the path for the root of the typings and grab it
 */
async function addModuleToRuntime(moduleName: string, typingsRootPath: string, config: ATAConfig) {
  const isDeno = typingsRootPath && typingsRootPath.indexOf('https://') === 0;
  const dtsFileURL = isDeno ? typingsRootPath : unpkgUrl(moduleName, typingsRootPath);
  const content =
    dtsCache[moduleName]?.[typingsRootPath] ?? (await getCachedDTSString(config, dtsFileURL));

  if (!content) {
    return errorMessage(
      `Could not get root d.ts file for the module '${moduleName}' at ${typingsRootPath}`,
      {},
    );
  }

  // Now look and grab dependent modules where you need the
  await getDependenciesForModule(content, moduleName, typingsRootPath, config);

  if (isDeno) {
    const wrapped = `declare module "${typingsRootPath}" { ${content} }`;
    config.addLibraryToRuntime(wrapped, typingsRootPath);

    return;
  }

  const moduleWithoutTypes = moduleName.split('@types/').slice(-1);
  const wrapped = `declare module "${moduleWithoutTypes}" { ${content} }`;

  config.addLibraryToRuntime(wrapped, `file:///node_modules/${moduleName}/${typingsRootPath}`);
}

/**
 * Takes a module import, then uses both the algolia API and the the
 * package.json to derive the root type def path.
 *
 * @param packageName
 */
async function getModuleAndRootDefTypePath(packageName: string, config: ATAConfig) {
  const url = moduleJsonUrl(packageName);
  const response = await config.fetcher(url);

  if (!response.ok) {
    return errorMessage(`Could not get Algolia JSON for the module '${packageName}'`, response);
  }

  const responseJSON = await response.json();

  if (!responseJSON) {
    return errorMessage(
      `Could the Algolia JSON was un-parsable for the module '${packageName}'`,
      response,
    );
  }

  if (!responseJSON.types) {
    return console.log(
      `There were no types for '${packageName}' - will not try again in this session`,
    );
  }

  if (!responseJSON.types.ts) {
    return console.log(
      `There were no types for '${packageName}' - will not try again in this session`,
    );
  }

  acquiredTypeDefinitions[packageName] = responseJSON;

  if (responseJSON.types.ts === 'included') {
    const modPackageURL = packageJsonUrl(packageName);
    const response = await config.fetcher(modPackageURL);

    if (!response.ok) {
      return errorMessage(`Could not get Package JSON for the module '${packageName}'`, response);
    }

    const responseJSON = await response.json();

    if (!responseJSON) {
      return errorMessage(`Could not get Package JSON for the module '${packageName}'`, response);
    }

    config.addLibraryToRuntime(
      JSON.stringify(responseJSON, null, '  '),
      `file:///node_modules/${packageName}/package.json`,
    );

    // Get the path of the root d.ts file

    // non-inferred route
    let rootTypePath = responseJSON.typing || responseJSON.typings || responseJSON.types;

    // package main is custom
    if (
      !rootTypePath &&
      typeof responseJSON.main === 'string' &&
      responseJSON.main.indexOf('.js') > 0
    ) {
      rootTypePath = responseJSON.main.replace(/js$/, 'd.ts');
    }

    // Final fallback, to have got here it must have passed in algolia
    if (!rootTypePath) {
      rootTypePath = 'index.d.ts';
    }

    return { mod: packageName, path: rootTypePath, packageJSON: responseJSON };
  }

  if (responseJSON.types.ts === 'definitely-typed') {
    return {
      mod: responseJSON.types.definitelyTyped,
      path: 'index.d.ts',
      packageJSON: responseJSON,
    };
  }

  throw "This shouldn't happen";
}

async function getCachedDTSString(config: ATAConfig, url: string) {
  const cached = localStorage.getItem(url);

  if (cached) {
    const [dateString, text] = cached.split('-=-^-=-');
    const cachedDate = new Date(dateString);
    const now = new Date();

    const cacheTimeout = 604800000; // 1 week
    // const cacheTimeout = 60000 // 1 min

    if (now.getTime() - cachedDate.getTime() < cacheTimeout) {
      return decompressFromUTF16(text);
    }

    console.log('Skipping cache for', url);
  }

  const response = await config.fetcher(url);

  if (!response.ok) {
    return errorMessage(`Could not get DTS response for the module at ${url}`, response);
  }

  // TODO: handle checking for a resolve to index.d.ts whens someone imports the
  // folder
  const content = await response.text();

  if (!content) {
    return errorMessage(`Could not get text for DTS response at ${url}`, response);
  }

  const now = new Date();
  const cacheContent = `${now.toISOString()}-=-^-=-${compressToUTF16(content)}`;
  localStorage.setItem(url, cacheContent);
  return content;
}

async function getReferenceDependencies(
  sourceCode: string,
  mod: string,
  path: string,
  config: ATAConfig,
) {
  let match;

  if (sourceCode.indexOf('reference path') > 0) {
    // https://regex101.com/r/DaOegw/1
    const referencePathExtractionPattern = /<reference path="(.*)" \/>/gm;

    while ((match = referencePathExtractionPattern.exec(sourceCode)) !== null) {
      const relativePath = match[1];

      if (relativePath) {
        const newPath = mapRelativePath(relativePath, path);

        if (newPath) {
          const dtsRefURL = unpkgUrl(mod, newPath);

          const dtsReferenceResponseText = await getCachedDTSString(config, dtsRefURL);

          if (!dtsReferenceResponseText) {
            return errorMessage(
              `Could not get root d.ts file for the module '${mod}' at ${path}`,
              {},
            );
          }

          await getDependenciesForModule(dtsReferenceResponseText, mod, newPath, config);
          config.addLibraryToRuntime(
            dtsReferenceResponseText,
            `file:///node_modules/${mod}/${newPath}`,
          );
        }
      }
    }
  }
}

interface ATAConfig {
  /**
   * The current source code of the playground editor.
   */
  sourceCode: string;

  /**
   * A method to add the library to the runtime of the playground.
   */
  addLibraryToRuntime: AddLibraryToRuntime;
  fetcher: typeof fetch;
}

/**
 * Pseudo in-browser type acquisition tool, uses a
 */
export async function detectNewImportsToAcquireTypeFor(
  sourceCode: string,
  addLibraryToRuntime: AddLibraryToRuntime,
  fetcher = fetch,
) {
  // Basically start the recursion with an undefined module
  const config: ATAConfig = {
    sourceCode,
    // Wrap the runtime func with our own side-effect for visibility
    addLibraryToRuntime: (code: string, path: string) => {
      pseudoGlobal.__typeDefinitions[path] = code;
      addLibraryToRuntime(code, path);
    },
    fetcher,
  };
  const results = getDependenciesForModule(sourceCode, undefined, 'playground.ts', config);
  return results;
}

/**
 * Take a `.js` / `.d.ts` file and recurse through all the dependencies.
 */
async function getDependenciesForModule(
  sourceCode: string,
  moduleName: string | undefined,
  path: string,
  config: ATAConfig,
) {
  // Get all the import/requires for the file
  const filteredModulesToLookAt = parseFileForModuleReferences(sourceCode);
  const promises = filteredModulesToLookAt.map(getModuleDtsCreator({ moduleName, config, path }));

  // Also support the triple slash directives.
  getReferenceDependencies(sourceCode, moduleName ?? '', path, config);

  Promise.all(promises).catch((error) => {
    console.log(error);
  });
}

interface GetModuleDtsParameter {
  /**
   * The name of the package or module from which the dts file is being
   * requested. e.g. `react` or undefined if being requested via the playground
   * root.
   */
  moduleName: string | undefined;
  config: ATAConfig;

  /**
   * The current that is being checked. In the playground the path is `playground.ts`
   */
  path: string;
}

function getModuleDtsCreator(
  parameter: GetModuleDtsParameter,
): (value: string, index: number, array: string[]) => Promise<void> {
  const { moduleName, config, path } = parameter;

  return async (name) => {
    // Support grabbing the hard-coded node modules if needed.
    const moduleToDownload = mapModuleNameToModule(name);

    if (!moduleName && moduleToDownload.startsWith('.')) {
      return console.log("[ATA] Can't resolve relative dependencies from the playground root");
    }

    const moduleID = createModuleReferenceId({
      outerModule: moduleName ?? '',
      moduleDeclaration: moduleToDownload,
      currentPath: moduleName ?? '',
    });

    // Don't try to populate the type again if already acquired, if there is an
    // error or if it's currently being populated.
    if (acquiredTypeDefinitions[moduleID] || acquiredTypeDefinitions[moduleID] === null) {
      return;
    }

    console.log(`[ATA] Looking at ${moduleToDownload}`);

    // This module is scoped with no nested imports.
    const moduleIsScopedOnly =
      moduleToDownload.indexOf('@') === 0 && moduleToDownload.split('/').length === 2;

    // This is a top level module with no nested imports.
    const moduleIsPackageOnly =
      !moduleToDownload.includes('@') && moduleToDownload.split('/').length === 1;

    const isPackageRootImport = moduleIsPackageOnly || moduleIsScopedOnly;
    const isDenoModule = moduleToDownload.indexOf('https://') === 0;

    if (isPackageRootImport) {
      // So it doesn't run twice for a package
      acquiredTypeDefinitions[moduleID] = null;

      // `import danger from "danger"`
      const packageDef = await getModuleAndRootDefTypePath(moduleToDownload, config);

      if (packageDef) {
        acquiredTypeDefinitions[moduleID] = packageDef.packageJSON;
        await addModuleToRuntime(packageDef.mod, packageDef.path, config);
      }
    } else if (isDenoModule) {
      // `import { serve } from "https://deno.land/std@v0.12/http/server.ts";`
      await addModuleToRuntime(moduleToDownload, moduleToDownload, config);
    } else {
      // `import {Component} from "./MyThing"`
      if (!moduleToDownload || !path) {
        throw `No outer module or path for a relative import: ${moduleToDownload}`;
      }

      const absolutePathForModule = mapRelativePath(moduleToDownload, path);

      // So it doesn't run twice for a package
      acquiredTypeDefinitions[moduleID] = null;

      const resolvedFilepath = absolutePathForModule.endsWith('.ts')
        ? absolutePathForModule
        : `${absolutePathForModule}.d.ts`;

      await addModuleToRuntime(moduleName ?? '', resolvedFilepath, config);
    }
  };
}

declare global {
  const __typeDefinitions: TypeDefinitions;
  const __dtsCache: DtsCache;
}
