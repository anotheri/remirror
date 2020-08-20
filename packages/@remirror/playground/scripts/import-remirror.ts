import chalk from 'chalk';
import fs, { Stats } from 'fs';
import { join, resolve } from 'path';
import { format, resolveConfig } from 'prettier';

import {
  createModuleReferenceId,
  isDisallowed,
  mapModuleNameToModule,
  parseFileForModuleReferences,
} from '../src/playground-utils';
import type { DtsCache } from '../src/vendor/type-acquisition';

// De-structure the promise versions of the file system API's used for this
// script.
const { writeFile, readdir, readFile, lstat } = fs.promises;

console.log(chalk`{grey Starting the playground:imports script. }`);

// @ts-ignore This is needed to fake a browser environment.
global.WebSocket = class {};

/**
 * Resolve the provided path relative to the base directory of this project.
 */
function baseDir(...paths: string[]) {
  return resolve(__dirname, '../../../../', ...paths);
}

interface PopulateRemirrorImports {
  /**
   * The absolute path to the source folder of the sub directory.
   */
  absolutePath: string;

  /**
   * The import name of the containing folder of the sub directory imports. e.g.
   * `remirror/extension`.
   */
  namedImportFolder: string;

  /**
   * The folders to search through for the sub imports. If `undefined` defaults
   * to searching through all folders for the given `absolutePath`.
   */
  foldersToCheck?: string[];
}

/**
 * Get the imports from the `remirror/` module and transform them into:
 *
 * - dts file mappings
 * - import keys
 * - the scoped name
 * - a pseudo `package.json`
 *
 * All of this is then used to create the files which add all the extension and
 * presets to the code and enable intellisense in the monaco editor via `*.d.ts`
 * files..
 */
async function populateRemirrorImports(
  parameter: PopulateRemirrorImports,
): Promise<Record<string, PackageModuleMeta>> {
  const { absolutePath, namedImportFolder, foldersToCheck } = parameter;
  const result: Record<string, PackageModuleMeta> = {};
  const folders = foldersToCheck ?? (await readdir(absolutePath));

  // Loop through the folders and extra the required data.
  for (const folder of folders) {
    // Skip the folder if it's the build directory.
    if (folder === 'dist') {
      continue;
    }

    // Check if this is the package.json file meaning we should use the root
    // name for imports.
    const isRoot = folder === 'package.json';
    const path = isRoot ? absolutePath : join(absolutePath, folder);
    const name = isRoot ? namedImportFolder : join(namedImportFolder, folder);

    // The `package.json` file.
    const packageJson = require(`${path}/package.json`);

    // The main entry point relative to the current folder.
    const relativeEntryPoint = packageJson.browser?.[`./${packageJson.main}`] ?? packageJson.main;
    const mainPath = resolve(path, relativeEntryPoint);

    // Get the names of the exports from this module.
    const exports = Object.keys(require(mainPath));

    // Populate the dts file map and retrieve all the data.
    result[folder] = await importSubdirectory(name, exports);
  }

  return result;
}

/**
 * Convert the nested import name to be a scoped package name.
 *
 * @param nestedImport - a name like `remirror/extension/bold`
 * @returns a name like `@remirror/extension-bold`
 */
function subDirectoryToScopedPackage(nestedImport: string) {
  // The correct name pattern for scoped packages is `@remirror/<TYPE>-<OTHER>.
  // This gets the hyphenated end part.
  const endPart = nestedImport
    .replace(/^remirror\//, '')
    .split('/')
    .join('-');

  return `@remirror/${endPart}`;
}

interface PackageDeclarations {
  /**
   * The name of the package the declarations belong to and the DtsMap. Name is
   * either scoped `@remirror/extension-bold` or a sub import
   * `remirror/extension/bold`.
   */
  [name: string]: DtsFileContents;
}

interface PackageModuleMeta {
  /**
   * The name of the module which will be used for the `package.json`.
   */
  name: string;

  /**
   * The exports from the module.
   */
  exports: string[];

  /**
   * The scoped name of the package e.g. `@remirror/extension-bold`.
   */
  scopedName: string;

  /**
   * An object mapping of the types that should be added to the monaco editor
   * instance.
   */
  declarations: PackageDeclarations;

  /**
   * The pseudo package.json as a string value.
   */
  packageJson: string;

  /**
   * The package json for the scoped module as a string.
   */
  scopedPackageJson: string;
}

/**
 * Import the extension. This is a separate function to allow for future changes
 * in the API.
 */
async function importSubdirectory(name: string, exports: string[]): Promise<PackageModuleMeta> {
  const scopedName = subDirectoryToScopedPackage(name);

  // Get the declaration directory.
  const dtsFolder = baseDir('packages', scopedName, 'dist', 'declarations', 'src');
  const contents = await getDtsFileContents(dtsFolder);

  const declarations: PackageDeclarations = {
    // remirror: remapRemirrorContent(name, contents), '@remirror':
    // remapRemirrorContent(scopedName, contents),
    [scopedName]: contents,
  };

  // Get the package.json file for the scoped package and modify the entry
  // point.
  const scopedPackageJson = JSON.stringify({ name: scopedName, types: 'index.d.ts' });
  const packageJson = JSON.stringify({ name, types: 'index.d.ts' });

  return {
    name,
    scopedName,
    exports,
    declarations,
    packageJson,
    scopedPackageJson,
  };
}

/**
 * Safely get the stats for a file or directory.
 *
 * @param {string} target
 * @returns a promise of the file information if it exists.
 */
async function getFileStat(target: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(target);
    return stat;
  } catch {
    return;
  }
}

/** A type alias of the string for better naming */
type FileContents = string;

/**
 * The type of the package declarations object which is returned for each
 * package.
 */
type DtsFileContents = Record<string, FileContents>;

/**
 * Keeps track of all the external modules which have been required by the
 * internal packages. These are added to the file produced as imports to a file
 * and run through the `type-acquisition.ts` file in order to download all the
 * required types at runtime.
 *
 * This seemed much easier than rebuilding the functionality for node.
 */
const EXTERNAL_MODULES = new Set<string>([]);

/**
 * Load all type declarations from a given path.
 *
 * @param dtsFolder - The absolute path to the definition types folder.
 * @param subFolder - The relative path from the dtsFolder to the sub-folders.
 * @returns and object of monaco libraries paths and their file contents
 */
async function getDtsFileContents(dtsFolder: string, subFolder = ''): Promise<DtsFileContents> {
  // Keeps track of the declaration files for this
  let dtsFileContents: DtsFileContents = {};

  for (const declaration of await readdir(dtsFolder)) {
    const key = join(subFolder, declaration);
    const filePath = join(dtsFolder, declaration);
    const filePathStat = await getFileStat(filePath);

    if (!filePathStat) {
      continue;
    }

    if (filePathStat.isDirectory()) {
      const nestedDeclarations = await getDtsFileContents(join(dtsFolder, declaration), key);

      dtsFileContents = { ...dtsFileContents, ...nestedDeclarations };
      continue;
    }

    if (!filePath.endsWith('.d.ts')) {
      continue;
    }

    const fileContents = await readDtsFile(filePath, key);
    dtsFileContents = { ...dtsFileContents, ...fileContents };
  }

  return dtsFileContents;
}

/**
 * Read a single dts file.
 */
async function readDtsFile(filePath: string, key: string): Promise<DtsFileContents> {
  const dts = await readFile(filePath, { encoding: 'utf-8' });

  // Here I want to get all the external modules that are valid and don't belong
  // to remirror and keep track of them. They can either be added manually via
  // this file, or perhaps a way to add them at runtime should be sought.
  parseFileForModuleReferences(dts)
    .map(mapModuleNameToModule)
    .filter((name) => !isDisallowed(name))
    .forEach((name) => EXTERNAL_MODULES.add(name));

  return { [key]: dts };
}

/**
 * Use this to preload the types from external libraries.
 *
 * - react
 * - react-dom
 * - prosemirror-*
 * - multishift
 * - @remirror/pm
 */
async function preloadRequiredLibraries(
  dtsCache: DtsCache,
  typeDefinitionMap: Record<string, { id: string; packageJson: string }>,
) {
  type ModuleName = string;
  type AbsolutePath = string;

  // We can't use `require.resolve` since pnpm doesn't hoist all packages.
  // Instead we're going to look at the special `.pnpm` folder inside the root
  // `node_modules`.

  // Get the folder for `@types`
  const pnpmTypeFolder = baseDir('node_modules', '.pnpm', '@types');

  // Get the folder for `.pnpm`.
  const pnpmFolder = baseDir('node_modules', '.pnpm');

  // Read the directories of both folders to be able to search through the
  // folder names which are postfixed with a version number.
  const [pnpmTypeFolders, pnpmFolders] = await Promise.all([
    readdir(pnpmTypeFolder),
    readdir(pnpmFolder),
  ]);

  /** A function which retrieves the package folder for a given package name. */
  function getPackageFolder(name: string) {
    const inTypesFolder = name.startsWith('@types/');
    const folderName = name.replace('@types/', '');
    const searchFolders = inTypesFolder ? pnpmTypeFolders : pnpmFolders;
    const directory = searchFolders.find((name) => name.startsWith(`${folderName}@`));

    if (!directory) {
      console.warn(chalk`{red.bold No directory found for: } {white name }`);
      return '';
    }

    return join(inTypesFolder ? pnpmTypeFolder : pnpmFolder, directory, 'node_modules', name);
  }

  // The list of packages that should be preloaded and the location of their root `*.d.ts` file.
  const preloadList: Array<[ModuleName, AbsolutePath]> = [
    ['remirror', baseDir('packages/remirror/dist/declarations/src/index.d.ts')],
    ['multishift', baseDir('packages/multishift/dist/declarations/src')],
    ['prosemirror-suggest', baseDir('packages/prosemirror-suggest/dist/declarations/src')],
    ['@remirror/dev', baseDir('packages/@remirror/dev/dist/declarations/src')],
    [
      '@remirror/playground',
      baseDir('packages/@remirror/playground/dist/declarations/src/use-remirror-playground.d.ts'),
    ],
    ['@remirror/pm/commands', baseDir('packages/@remirror/pm/dist/declarations/src/commands.d.ts')],
    [
      '@remirror/pm/dropcursor',
      baseDir('packages/@remirror/pm/dist/declarations/src/dropcursor.d.ts'),
    ],
    [
      '@remirror/pm/gapcursor',
      baseDir('packages/@remirror/pm/dist/declarations/src/gapcursor.d.ts'),
    ],
    ['@remirror/pm/history', baseDir('packages/@remirror/pm/dist/declarations/src/history.d.ts')],
    [
      '@remirror/pm/inputrules',
      baseDir('packages/@remirror/pm/dist/declarations/src/inputrules.d.ts'),
    ],
    ['@remirror/pm/keymap', baseDir('packages/@remirror/pm/dist/declarations/src/keymap.d.ts')],
    ['@remirror/pm/model', baseDir('packages/@remirror/pm/dist/declarations/src/model.d.ts')],
    [
      '@remirror/pm/schema-list',
      baseDir('packages/@remirror/pm/dist/declarations/src/schema-list.d.ts'),
    ],
    ['@remirror/pm/state', baseDir('packages/@remirror/pm/dist/declarations/src/state.d.ts')],
    ['@remirror/pm/suggest', baseDir('packages/@remirror/pm/dist/declarations/src/suggest.d.ts')],
    ['@remirror/pm/tables', baseDir('packages/@remirror/pm/dist/declarations/src/tables.d.ts')],
    [
      '@remirror/pm/transform',
      baseDir('packages/@remirror/pm/dist/declarations/src/transform.d.ts'),
    ],
    ['@remirror/pm/view', baseDir('packages/@remirror/pm/dist/declarations/src/view.d.ts')],
    ['react', getPackageFolder('@types/react')],
    ['react-dom', getPackageFolder('@types/react-dom')],
    ['prosemirror-view', getPackageFolder('@types/prosemirror-view')],
    ['prosemirror-commands', getPackageFolder('@types/prosemirror-commands')],
    ['prosemirror-dropcursor', getPackageFolder('@types/prosemirror-dropcursor')],
    ['prosemirror-gapcursor', getPackageFolder('@types/prosemirror-gapcursor')],
    ['prosemirror-history', getPackageFolder('@types/prosemirror-history')],
    ['prosemirror-inputrules', getPackageFolder('@types/prosemirror-inputrules')],
    ['prosemirror-keymap', getPackageFolder('@types/prosemirror-keymap')],
    ['prosemirror-model', getPackageFolder('@types/prosemirror-model')],
    ['prosemirror-schema-list', getPackageFolder('@types/prosemirror-schema-list')],
    ['prosemirror-state', getPackageFolder('@types/prosemirror-state')],
    ['prosemirror-transform', getPackageFolder('@types/prosemirror-transform')],
    ['prosemirror-tables', getPackageFolder('prosemirror-tables')],

    ['type-fest', getPackageFolder('type-fest')],
    ['nanoevents', getPackageFolder('nanoevents')],
    ['react-use', getPackageFolder('react-use')],
    ['yjs', getPackageFolder('yjs')],
    ['lib0', getPackageFolder('lib0')],
    ['make-error', getPackageFolder('make-error')],
    ['json.macro', getPackageFolder('json.macro')],
    ['case-anything', getPackageFolder('case-anything')],
    ['csstype', getPackageFolder('csstype')],
    ['make-plural', getPackageFolder('make-plural')],

    ['prismjs', getPackageFolder('@types/prismjs')],
    ['refractor', getPackageFolder('@types/refractor')],
    ['refractor', getPackageFolder('@types/refractor')],
    ['orderedmap', getPackageFolder('@types/orderedmap')],
    ['throttle-debounce', getPackageFolder('@types/throttle-debounce')],
    ['object.omit', getPackageFolder('@types/object.omit')],
    ['object.pick', getPackageFolder('@types/object.pick')],
  ];

  for (const [packageName, dtsFolder] of preloadList) {
    // This id is for the type-acquisition on the front end which uses it to
    // determine whether it needs to retrieve definitions. We want that to not
    // happen for any of these packages.
    const id = createModuleReferenceId({
      currentPath: 'playground.ts',
      moduleDeclaration: packageName,
    });
    typeDefinitionMap[packageName] = {
      packageJson: JSON.stringify({ name: packageName, types: 'index.d.ts' }),
      id,
    };

    // Add the `*.d.ts` files for the current package name. Can be one file (in
    // the object) e.g. `{ 'index.d.ts': 'CONTENT' }` or a mapping to a whole
    // file structure.
    dtsCache[packageName] = dtsFolder.endsWith('.d.ts')
      ? await readDtsFile(dtsFolder, 'index.d.ts')
      : await getDtsFileContents(dtsFolder);
  }
}

interface RemirrorModuleMap {
  [key: string]: PackageModuleMeta;
}

/**
 * The groups of imports that we're interested in for the editor.
 */
interface ImportGroups {
  extensions: RemirrorModuleMap;
  presets: RemirrorModuleMap;
  core: RemirrorModuleMap;
  react: RemirrorModuleMap;
}

/**
 * Generate the code strings which should be used to create the files for the
 * `../src/generated` folder.
 */
async function generateCode(parameter: ImportGroups) {
  const { extensions, presets, core, react } = parameter;
  const currentPath = 'playground.tsx';
  const importGroups: PackageModuleMeta[] = [
    ...Object.values(core),
    ...Object.values(extensions),
    ...Object.values(presets),
    ...Object.values(react),
  ];

  // Set up the containers for the data that will be used to populate the
  // templates returned from this function.
  const unscopedImports: string[] = [];
  const scopedImports: string[] = [];
  const typeDefinitionMap: Record<string, { id: string; packageJson: string }> = {};
  const dtsCache: DtsCache = {};

  // Load other required libraries.
  await preloadRequiredLibraries(dtsCache, typeDefinitionMap);

  for (const meta of importGroups) {
    // These id's are used for the type-acquisition on the front end to prevent
    // double loading of `*.d.ts` files.
    const id = createModuleReferenceId({ currentPath, moduleDeclaration: meta.name });
    const scopedId = createModuleReferenceId({ currentPath, moduleDeclaration: meta.scopedName });

    // Used on the front end to add package.json files to the monaco editor file
    // system.
    typeDefinitionMap[meta.name] = { packageJson: meta.packageJson, id };
    typeDefinitionMap[meta.scopedName] = { packageJson: meta.scopedPackageJson, id: scopedId };

    // Update the `*.d.ts` cache which will be added on the front end to provide
    // intellisense for users of the playground.
    dtsCache[meta.scopedName] = meta.declarations[meta.scopedName];

    // Both the scoped and unscoped imports point to the same module.
    unscopedImports.push(`${JSON.stringify(meta.name)}: require(${JSON.stringify(meta.name)})`);
    scopedImports.push(`${JSON.stringify(meta.scopedName)}: require(${JSON.stringify(meta.name)})`);
  }

  const externalArray = [...EXTERNAL_MODULES.values()];

  // Check for any un-imported packages.
  for (const key of Object.keys(dtsCache)) {
    externalArray
      .filter((value) => value.startsWith(`${key}/`) || value.length <= 2 || value === key)
      .forEach((value) => EXTERNAL_MODULES.delete(value));
  }

  if (EXTERNAL_MODULES.size > 0) {
    console.warn(
      chalk`{yellow The following modules are imported and require *.d.ts files: }\n\n - ${[
        ...EXTERNAL_MODULES.values(),
      ].join('\n - ')}`,
    );
  } else {
    console.log(chalk`{blue {bold 0} missing *.d.ts modules found. }`);
  }

  const json = `${JSON.stringify(
    {
      AUTO_GENERATED: 'DO NOT EDIT',
      typeDefinitionMap,
      dtsCache,
    },
    null,
    2,
  )}`;

  const modules = `\
/**
 * @module
 *
 * DO NOT EDIT: AUTO-GENERATED FILE
 * @see \`@remirror/playground/scripts/import-remirror.ts\`
 */

import { useRemirrorPlayground } from '../use-remirror-playground';

export const IMPORT_CACHE: { [moduleName: string]: any } = {
  // Automated unscoped imports.
  ${unscopedImports.join(',\n  ')},

  // Automated scoped imports.
  ${scopedImports.join(',\n  ')},

  // Manually created imports.
  remirror: require('remirror'),
  '@remirror/dev': require('@remirror/dev'),
  '@remirror/playground': { useRemirrorPlayground },
  '@remirror/pm/commands': require('@remirror/pm/commands'),
  '@remirror/pm/dropcursor': require('@remirror/pm/dropcursor'),
  '@remirror/pm/gapcursor': require('@remirror/pm/gapcursor'),
  '@remirror/pm/history': require('@remirror/pm/history'),
  '@remirror/pm/inputrules': require('@remirror/pm/inputrules'),
  '@remirror/pm/keymap': require('@remirror/pm/keymap'),
  '@remirror/pm/model': require('@remirror/pm/model'),
  '@remirror/pm/schema-list': require('@remirror/pm/schema-list'),
  '@remirror/pm/state': require('@remirror/pm/state'),
  '@remirror/pm/suggest': require('@remirror/pm/suggest'),
  '@remirror/pm/tables': require('@remirror/pm/tables'),
  '@remirror/pm/transform': require('@remirror/pm/transform'),
  '@remirror/pm/view': require('@remirror/pm/view'),

  // Manually created external dependencies.
  react: require('react'),
  '@babel/runtime/helpers/interopRequireDefault': require('@babel/runtime/helpers/interopRequireDefault'),
  '@babel/runtime/helpers/interopRequireWildcard': require('@babel/runtime/helpers/interopRequireWildcard'),
  '@babel/runtime/helpers/slicedToArray': require('@babel/runtime/helpers/slicedToArray'),
  '@babel/runtime/helpers/createClass': require('@babel/runtime/helpers/createClass'),
  '@babel/runtime/helpers/possibleConstructorReturn': require('@babel/runtime/helpers/possibleConstructorReturn'),
  '@babel/runtime/helpers/extends': require('@babel/runtime/helpers/extends'),
  '@babel/runtime/helpers/assertThisInitialized': require('@babel/runtime/helpers/assertThisInitialized'),
  '@babel/runtime/helpers/classCallCheck': require('@babel/runtime/helpers/classCallCheck'),
  '@babel/runtime/helpers/inherits': require('@babel/runtime/helpers/inherits'),
  '@babel/runtime/helpers/defineProperty': require('@babel/runtime/helpers/defineProperty'),
};

/**
 * The names and exports of the internally created modules.
 */
export const INTERNAL_MODULES: Array<{ moduleName: string, exports: string[] }> = [
  ${importGroups
    .map((meta) => JSON.stringify({ moduleName: meta.name, exports: meta.exports }, null, 2))
    .join(',\n  ')}
];
`;

  const exports = `\
  /**
 * @module
 *
 * DO NOT EDIT: AUTO-GENERATED FILE
 * @see \`@remirror/playground/scripts/import-remirror.ts\`
 */

import { loadJson } from 'json.macro';

import type { DtsCache } from '../vendor/type-acquisition';

// Use a babel macro to load the json file.
const { dtsCache, typeDefinitionMap } = loadJson('./dts.json');

/**
 * The pre populated cache of module names to their stringified package.json
 * file.
 */
export const TYPE_DEFINITION_MAP: Record<string, {id: string, packageJson: string}> = typeDefinitionMap;

/**
 * The pre populated cache of definition files.
 */
export const DTS_CACHE: DtsCache = dtsCache;
`;

  return {
    /** The require statements fo required libraries. */
    modules,
    /** JSON objects for the `*.d.ts` files for each module. */
    json,
    /** The exports the created `json` file via `babel-plugin-macro`. */
    exports,
  };
}

// The absolute paths to the of the unscoped `remirror/` subdirectory exports.
const extensionAbsolutePath = baseDir('packages', 'remirror', 'extension');
const presetAbsolutePath = baseDir('packages', 'remirror', 'preset');
const coreAbsolutePath = baseDir('packages', 'remirror', 'core');
const reactAbsolutePath = baseDir('packages', 'remirror', 'react');

// Where the generated file will be located.
const generatedFolder = baseDir('packages', '@remirror', 'playground', 'src', 'generated');
const modulesPath = join(generatedFolder, 'modules.ts');
const jsonPath = join(generatedFolder, 'dts.json');
const exportsPath = join(generatedFolder, 'exports.ts');

interface FileFormatterConfig {
  contents: string;
  filepath: string;
  parser?: 'json' | 'typescript';
}

/**
 * Format and write the files to the intended location.
 */
async function formatAndWriteFiles(files: FileFormatterConfig[]) {
  const prettierConfig = await resolveConfig(generatedFolder);

  const filePromises = files.map(({ filepath, parser = 'typescript', contents }) => {
    return writeFile(filepath, format(contents, { filepath, parser, ...prettierConfig }));
  });

  // Write to the formatted code to the output path for consumption by the rest
  // of the playground.
  await Promise.all(filePromises);
}

/**
 * This is the function run when the script is called, as is convention in other
 * languages.
 */
async function main() {
  const extensions = await populateRemirrorImports({
    absolutePath: extensionAbsolutePath,
    namedImportFolder: 'remirror/extension',
  });
  const presets = await populateRemirrorImports({
    absolutePath: presetAbsolutePath,
    namedImportFolder: 'remirror/preset',
  });
  const core = await populateRemirrorImports({
    absolutePath: coreAbsolutePath,
    namedImportFolder: 'remirror/core',
  });
  const react = await populateRemirrorImports({
    absolutePath: reactAbsolutePath,
    namedImportFolder: 'remirror/react',
    foldersToCheck: ['package.json', 'utils', 'social', 'wysiwyg'],
  });

  // Generate the code from the importGroups.
  const { exports, json, modules } = await generateCode({ extensions, presets, core, react });

  // Write the files to the intended location.
  await formatAndWriteFiles([
    { contents: exports, filepath: exportsPath },
    { contents: modules, filepath: modulesPath },
    { contents: json, filepath: jsonPath, parser: 'json' },
  ]);

  console.log(chalk`{green Successfully created the playground imports.}`);
}

// Run the script and listen for any errors.
main().catch((error) => {
  console.log(
    chalk`Something went wrong while running the {blue.bold playground:imports} script.}`,
  );
  console.error(error);
  process.exit(1);
});
