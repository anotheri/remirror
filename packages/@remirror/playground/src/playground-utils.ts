import { findMatches } from '@remirror/core-helpers';

interface GetMonacoFileName {
  packageName: string;
  relativePath: string;
  isDts?: boolean;
}

/**
 * The monaco file name from a relative path. This is added to the `addExtraLib`
 * method.
 *
 * @param packageName - the name being imported like `remirror/extension/bold`
 */
export function getEditorFilePath(options: GetMonacoFileName): string {
  const { packageName, relativePath, isDts = false } = options;
  return `file:///node_modules/${isDts ? '@types/' : ''}${packageName}/${relativePath}`;
}

/**
 * Grab any import/requires from inside the code and make a list of its
 * dependencies.
 *
 * @param sourceCode - the source of the definition file.
 *
 * @returns all unique matches found.
 */
export function parseFileForModuleReferences(sourceCode: string): string[] {
  // Track all the unique modules found so far.
  const foundModules = new Set<string>();

  // Regex used to test for a `require` module reference -
  // https://regex101.com/r/Jxa3KX/4
  const requirePattern = /(const|let|var)(.|\n)*? require\(('|")(.*)('|")\);?$/gm;

  // Regex used to test for `imports` module reference -
  // https://regex101.com/r/hdEpzO/4
  const es6Pattern = /(import|export)((?!from)(?!require)(.|\n))*?(from|require\()\s?('|")(.*)('|")\)?;?$/gm;

  // Regex used to test for only es6 imports - https://regex101.com/r/hdEpzO/6
  const es6ImportOnly = /import\s?('|")(.*)('|")\)?;?/gm;

  // Find all matches and add to the set.
  findMatches(sourceCode, es6Pattern).forEach((match) => foundModules.add(match[6]));
  findMatches(sourceCode, requirePattern).forEach((match) => foundModules.add(match[5]));
  findMatches(sourceCode, es6ImportOnly).forEach((match) => foundModules.add(match[2]));

  return [...foundModules];
}

/**
 * Converts some of the known global imports to node so that we grab the right
 * info
 */
export function mapModuleNameToModule(name: string) {
  const builtInNodeMods = new Set([
    '_http_agent',
    '_http_client',
    '_http_common',
    '_http_incoming',
    '_http_outgoing',
    '_http_server',
    '_stream_duplex',
    '_stream_passthrough',
    '_stream_readable',
    '_stream_transform',
    '_stream_wrap',
    '_stream_writable',
    '_tls_common',
    '_tls_wrap',
    'assert',
    'async_hooks',
    'buffer',
    'child_process',
    'cluster',
    'console',
    'constants',
    'crypto',
    'dgram',
    'dns',
    'domain',
    'events',
    'fs',
    'fs/promises',
    'http',
    'http2',
    'https',
    'inspector',
    'module',
    'net',
    'os',
    'path',
    'perf_hooks',
    'process',
    'punycode',
    'querystring',
    'readline',
    'repl',
    'stream',
    'string_decoder',
    'sys',
    'timers',
    'tls',
    'trace_events',
    'tty',
    'url',
    'util',
    'v8',
    'vm',
    'wasi',
    'worker_threads',
    'zlib',
  ]);

  if (builtInNodeMods.has(name)) {
    return 'node';
  }

  return name;
}

/**
 * The disallowed strings.
 */
const packagesToIgnore = [
  /^\./,
  /^@?remirror(?:$|\/)/,
  /^multishift$/,
  /^prosemirror-/,
  /^react$/,
  /^react-dom$/,
  /^api$/,
  /^prop-types$/,
  /^js-cookie$/,
  /^@babel\/core$/,
];

/**
 * Check if the start of a package is disallowed from being loaded.
 */
export function isDisallowed(name: string) {
  return packagesToIgnore.some((regex) => regex.test(name));
}

interface CreateModuleReferenceIdParameter {
  /**
   * The module from which this reference is being requested.
   */
  outerModule?: string;
  /**
   * The module declaration to be checked - `remirror/awesome` or `@remirror/react`.
   */
  moduleDeclaration: string;
  /**
   * The current path which is `playground.ts` for playground imports and
   */
  currentPath: string;
}

/**
 * An id which is used to store a reference to the type when it is retrieved.
 */
export function createModuleReferenceId(parameter: CreateModuleReferenceIdParameter) {
  const { currentPath, moduleDeclaration, outerModule } = parameter;

  // A scoped package with no sub import references.
  const isScopedPackageOnly =
    moduleDeclaration.indexOf('@') === 0 && moduleDeclaration.split('/').length === 2;

  // The module provided is not scoped and does not reference sub imports.
  const isPackageOnly =
    !moduleDeclaration.includes('@') && moduleDeclaration.split('/').length === 1;

  // This import is from the root of the provided module.
  const isPackageRootImport = isPackageOnly || isScopedPackageOnly;

  if (isPackageRootImport) {
    return moduleDeclaration;
  }

  return `${outerModule ?? ''}-${mapRelativePath(moduleDeclaration, currentPath)}`;
}

/**
 * A really basic version of `path.resolve`.
 */
function absolute(base: string, relative: string) {
  if (!base) {
    return relative;
  }

  const stack = base.split('/');
  const parts = relative.split('/');
  stack.pop(); // remove current file name (or empty string)

  for (const element of parts) {
    if (element === '.') {
      continue;
    }

    if (element === '..') {
      stack.pop();
    } else {
      stack.push(element);
    }
  }

  return stack.join('/');
}

/**
 * Map the relative path.
 *
 * Honestly, I'm not at all sure what this does 🤷‍♀️
 */
export function mapRelativePath(moduleDeclaration: string, currentPath: string) {
  // See https://stackoverflow.com/questions/14780350/convert-relative-path-to-absolute-using-javascript
  return absolute(currentPath, moduleDeclaration);
}

/**
 * Returns true if the name provided is an `Extension`.
 */
export function isExtensionName(exportName: string) {
  return exportName.endsWith('Extension') && /^[A-Z]/.test(exportName);
}

/**
 * Returns true if the name provided is a `Preset`
 */
export function isPresetName(exportName: string) {
  return exportName.endsWith('Preset') && /^[A-Z]/.test(exportName);
}

interface LoadScriptOptions {
  /**
   * An optional check which should be passed to customise when a script is
   * actually loaded. It defaults to return true straight away.
   *
   * The intention is that when loading scripts like babel you should be able to
   * check if the babel object is available on the window yet and return true
   * when it is, and the promises will resolve.
   */
  hasLoaded?: () => boolean;

  /**
   * The checking interval time in milliseconds.
   *
   * @default 100
   */
  timeout?: number;

  /**
   * The number of checks allowed before giving up.
   *
   * @default 100
   */
  maximumChecks?: number;
}

// Defaults used for the `loadScript` method.
const DEFAULT_MAX_CHECKS = 100;
const DEFAULT_TIMEOUT = 100;

/**
 * A utility method for loading a script with a checker method.
 *
 * - The script should only be loaded once in the session.
 * - The promise should resolve only when the check has successfully passed.
 */
export function loadScript(src: string, options: LoadScriptOptions = {}): Promise<void> {
  const {
    hasLoaded = () => true,
    maximumChecks = DEFAULT_MAX_CHECKS,
    timeout = DEFAULT_TIMEOUT,
  } = options;

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.setAttribute('src', src);
    document.body.append(script);
    let checks = 0;

    function onLoad() {
      const interval = setInterval(() => {
        if (checks >= maximumChecks) {
          reject();
        }

        checks++;

        if (!hasLoaded()) {
          return;
        }

        clearInterval(interval);
        resolve();
      }, timeout);
    }

    // Add event listeners which are triggered once only.
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', reject, { once: true });
  });
}

/**
 * A method which converts the TypeScript output to JavaScript without losing readability.
 *
 * As seen here: https://stackoverflow.com/a/62382812/2172153
 */
export function convertTypeScriptToJavaScript() {}
