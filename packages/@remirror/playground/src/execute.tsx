import * as crypto from 'crypto';
import { editor, languages } from 'monaco-editor';
import React, { FC, useContext, useEffect, useRef } from 'react';
import { render, unmountComponentAtNode } from 'react-dom';

import { entries, Shape } from 'remirror/core';

import { darkTheme } from './constants';
import { PlaygroundContext, PlaygroundContextObject } from './context';
import { ErrorBoundary } from './error-boundary';
import { DTS_CACHE, TYPE_DEFINITION_MAP } from './generated/exports';
import { IMPORT_CACHE, INTERNAL_MODULES } from './generated/modules';
import { getEditorFilePath, loadScript } from './playground-utils';
import { acquiredTypeDefinitions, dtsCache } from './vendor/type-acquisition';

// Start with these and cannot remove them
export const REQUIRED_MODULES = INTERNAL_MODULES.map((mod) => mod.moduleName);

editor.setTheme('darkTheme');

const fetchedModules: {
  [id: string]: {
    name: string;
    modulePromise: Promise<any>;
  };
} = {};

function hash(str: string): string {
  return `_${crypto.createHash('sha1').update(str).digest('hex')}`;
}

async function bundle(moduleName: string, id: string): Promise<any> {
  try {
    await loadScript(
      `http://bundle.run/${encodeURIComponent(moduleName)}@latest?name=${encodeURIComponent(id)}`,
    );

    console.log(`LOADED: ${moduleName}`);
    return (window as Shape)[id];
  } catch {
    console.error(`Failed to load ${moduleName}`);
  }
}

export async function makeRequire(requires: string[]) {
  const tasks: Array<Promise<void>> = [];
  const modules: { [moduleName: string]: any } = {};

  for (const moduleName of requires) {
    if (IMPORT_CACHE[moduleName]) {
      modules[moduleName] = IMPORT_CACHE[moduleName];
    } else {
      const id = hash(moduleName);

      if (!fetchedModules[id]) {
        fetchedModules[id] = {
          name: moduleName,
          modulePromise: bundle(moduleName, id),
        };
      }

      tasks.push(
        fetchedModules[id].modulePromise.then((remoteModule) => {
          modules[moduleName] = remoteModule;
        }),
      );
    }
  }

  await Promise.all(tasks);

  return function require(moduleName: string) {
    if (modules[moduleName]) {
      return modules[moduleName];
    }

    throw new Error(`Could not require('${moduleName}')`);
  };
}

/**
 * Fakes CommonJS stuff so that we can run the user code as if it were a
 * CommonJS module.
 */
function runCode(code: string, requireFn: (mod: string) => any) {
  const userModule = { exports: {} as any };
  eval(`(function userCode(require, module, exports) {${code}})`)(
    requireFn,
    userModule,
    userModule.exports,
  );

  return userModule;
}

function runCodeInDiv(
  div: HTMLDivElement,
  {
    code,
    requires,
    playground,
  }: { code: string; requires: string[]; playground: PlaygroundContextObject },
) {
  let active = true;

  (async function doIt() {
    try {
      // First do the requires.
      const requireFn = await makeRequire(requires);

      if (!active) {
        return;
      }

      // Then run the code to generate the React element
      const userModule = runCode(code, requireFn);
      const Component = userModule.exports.default || userModule.exports;

      // Then mount the React element into the div
      render(
        <ErrorBoundary>
          <PlaygroundContext.Provider value={playground}>
            <Component />
          </PlaygroundContext.Provider>
        </ErrorBoundary>,
        div,
      );
    } catch (error) {
      console.error(error);
      render(
        <div>
          <h1>Error occurred</h1>
          <pre>
            <code>{String(error)}</code>
          </pre>
        </div>,
        div,
      );
    }
  })();

  return () => {
    active = false;
    unmountComponentAtNode(div);
  };
}

export interface ExecuteProps {
  /** The JavaScript code to execute (in CommonJS syntax) */
  code: string;

  /** A list of the modules this code `require()`s */
  requires: string[];
}

/**
 * Executes the given `code`, mounting the React component that it exported (via
 * `export default`) into the DOM. Is automatically debounced to prevent
 * over-fetching npm modules during typing.
 */
export const Execute: FC<ExecuteProps> = function (props) {
  const { code, requires } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const playground = useContext(PlaygroundContext);
  useEffect(() => {
    if (!ref.current) {
      return;
    }

    const release = runCodeInDiv(ref.current, { code, requires, playground });
    return () => {
      release();
    };
  }, [code, requires, playground]);

  return <div ref={ref} style={{ height: '100%' }} />;
};
