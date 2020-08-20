/**
 * @packageDocumentation
 *
 * This module is where the state for the playground is managed. It is
 * responsible for loading the monaco editor, injecting the babel, and
 */

import type * as Monaco from 'monaco-editor';
import create from 'zustand';

import { entries, invariant, pick } from 'remirror/core';

import { compilerOptions, editorThemes } from './constants';
import { getEditorFilePath } from './playground-utils';
import { detectNewImportsToAcquireTypeFor } from './vendor/type-acquisition';

const MATCHING_REGEX = /^@remirror\/(?:core|react|preset|extension)/;

/**
 * A singleton responsible for managing the loading of the editor and other
 * jobs. This makes use of dynamic imports to make sure large files and editor
 * specific functionality is only loaded at the time it is needed.
 */
class PlaygroundSingleton {
  #monaco?: typeof Monaco;

  /**
   * Keeps track of whether the editor has been initialized.
   */
  #initialized = false;

  /**
   * The full monaco namespace import.
   */
  get monaco(): typeof Monaco {
    invariant(this.#monaco, {
      message: 'Monaco was reference before being loaded. Please call `loadMonaco` method first.',
    });

    return this.#monaco;
  }

  /**
   * The monaco editor
   */
  get editor(): typeof Monaco.editor {
    return this.monaco.editor;
  }

  /**
   * A shorthand way of accessing languages.
   */
  get languages(): typeof Monaco.languages {
    return this.monaco.languages;
  }

  /**
   * A shorthand way of accessing typescript
   */
  get typescript(): typeof Monaco.languages.typescript.typescriptDefaults {
    return this.languages.typescript.typescriptDefaults;
  }

  /**
   * A shorthand way of accessing javascript
   */
  get javascript(): typeof Monaco.languages.typescript.javascriptDefaults {
    return this.languages.typescript.typescriptDefaults;
  }

  /**
   * Load the monaco editor asynchronously. This allows for splitting the build
   * so that the playground isn't loaded until absolutely necessary.
   */
  async loadMonaco() {
    this.#monaco = await import('monaco-editor');
  }

  /**
   * This method is used to add types to the monaco editor runtime.
   */
  private addLibraryToRuntime(code: string, path: string) {
    this.typescript.addExtraLib(code, path);
  }

  /**
   * The function that is run when the editor is first created in order to
   * populate the editor types.
   */
  async populateEditorTypes() {
    const [
      { DTS_CACHE, TYPE_DEFINITION_MAP },
      { acquiredTypeDefinitions, dtsCache },
    ] = await Promise.all([import('./generated/exports'), import('./vendor/type-acquisition')]);

    // Loop through the prepared DTS_CACHE and add it to the list of cached
    // modules.
    for (const [packageName, dtsFileContents] of entries(DTS_CACHE)) {
      dtsCache[packageName] = dtsFileContents;
      this.addDtsFiles(packageName, dtsFileContents);
    }

    // Each package needs to store a package.json file.
    const relativePath = 'package.json';

    // Loop through the prepared `TYPE_DEFINITION_MAP` and add to the list of cached
    // modules.
    for (const [packageName, { packageJson, id }] of entries(TYPE_DEFINITION_MAP)) {
      // The `type-acquisition` script requires a special module id to prevent
      // multiple requests for the same module.
      acquiredTypeDefinitions[id] = packageJson;

      // Add the stringified package.json file to the files in node modules.
      this.addLibraryToRuntime(packageName, getEditorFilePath({ packageName, relativePath }));
    }
  }

  /**
   * Add the `.d.ts` files for each package to the editor.
   */
  addDtsFiles(packageName: string, dtsFileContents: Record<string, string>) {
    // Loop through the dts paths and the dts contents of each endpoitn for this
    // package.
    for (const [relativePath, contents] of entries(dtsFileContents)) {
      // Add the pre compiled `.d.ts` file to the `node_modules` file system for
      // the monaco editor.
      this.addLibraryToRuntime(
        contents,
        getEditorFilePath({ packageName, relativePath, isDts: false }),
      );
    }

    // Since all remirror packages have a certain pattern it is possible to know
    // if a package is included based the regex defined earlier.
    const isIncludedWithRemirror = MATCHING_REGEX.test(packageName);

    // When the package name is not included with remirror as a subdirectory
    // subdirectory of `remirror` then we can add it as it is.
    if (!isIncludedWithRemirror) {
      return;
    }

    // At this point we know the package is also exported as a subdirectory of
    // `remirror`. As a result we need to:
    // - Create the subdirectory name from the scoped name.
    // - Create contents for the subdirectory which point to the scoped name.
    // - Add both the scoped package name and subdirectory name to the monaco
    //   editor.

    // Get the end segment of the scoped name `@remirror/core-utils` =>
    // `core-utils`. We need this to create the new sub directory import since
    // `core-utils` => `remirror/core/utils`.
    const [, endSegment] = packageName.split('/');

    // Convert the filename to a sub directory path which appends the
    // `index.d.ts` to make it the default entry point.
    const relativePath = `${endSegment.split('-').join('/')}/index.d.ts`;

    // Point the contents of the sub directory `remirror` import to the original
    // scoped package. e.g. `remirror/core/utils` would have a value of `export *
    // from '@remirror/core-utils';`
    const updatedContents = `export * from '${packageName}';`;

    // Add the subdirectory and it's contents to the monaco editor.
    this.addLibraryToRuntime(
      updatedContents,
      getEditorFilePath({
        packageName: 'remirror',
        relativePath,
        isDts: false,
      }),
    );
  }

  /** Prepare the editor for usage. */
  setupEditor() {
    if (this.#initialized) {
      return;
    }

    this.typescript.setCompilerOptions(compilerOptions);
    this.javascript.setCompilerOptions(compilerOptions);

    for (const [name, theme] of entries(editorThemes)) {
      this.editor.defineTheme(name, theme);
    }

    this.#initialized = true;
  }

  /** Get the model for the active editor. */
  getModel(value = '') {
    this.setupEditor();

    return this.editor.createModel(
      value,
      'typescript',
      this.monaco.Uri.parse('file://playground.tsx'),
    );
  }

  /**
   * Create the editor and attach it to the dom.
   *
   * This will be created each time an editor is attached and the return value
   * is used by the `PlaygroundCodeEditor`.
   */
  createEditorAndAttach(element: HTMLElement, model: Monaco.editor.ITextModel) {
    return this.editor.create(element, {
      model,
      language: 'typescript',
      fontSize: 16,
      fontFamily: '"Fira Code", Menlo, Monaco, "Courier New", monospace',
      fontLigatures: true,
      minimap: {
        enabled: false,
      },
    });
  }

  /**
   * A method which creates a type getter and calls it once for the current
   * value
   */
  createTypeGetter(model: Monaco.editor.ITextModel) {
    const addLibraryToRuntime = this.addLibraryToRuntime;

    const getTypes = () => {
      detectNewImportsToAcquireTypeFor(
        model.getValue(),
        addLibraryToRuntime,
        window.fetch.bind(window),
      );
    };

    getTypes();

    return getTypes;
  }

  /**
   * Handle updating the layout of the editor.
   */
  handleLayout(editorInstance: Monaco.editor.IStandaloneCodeEditor | undefined) {
    function layout() {
      if (!editorInstance) {
        return;
      }

      editorInstance.layout();
    }

    // Setup the initial render.
    layout();

    // Also layout whenever the window resizes
    window.addEventListener('resize', layout, false);

    // Return a dispose function.
    return () => {
      // Clean up when the component is unmounted.
      window.removeEventListener('resize', layout, false);
    };
  }

  async loadBabel() {}
  async loadPrettier() {}
}

const singleton = new PlaygroundSingleton();

interface PlaygroundState {
  singleton: PlaygroundSingleton;
  value: string;
  readOnly: boolean;
  setValue: (value: string) => void;
  setReadOnly: (readonly: boolean) => void;
}

export const usePlaygroundState = create<PlaygroundState>((set) => ({
  singleton,
  value: '',
  readOnly: true,
  setValue: (value: string) => set({ value }),
  setReadOnly: (readOnly: boolean) => set({ readOnly }),
}));

/**
 * The selectors for the state.
 */
export const selectors = {
  /** Pick the selectors needed within the code editor. */
  code: (
    state: PlaygroundState,
  ): Pick<PlaygroundState, 'readOnly' | 'setValue' | 'value' | 'singleton'> =>
    pick(state, ['readOnly', 'setValue', 'value', 'singleton']),
};
