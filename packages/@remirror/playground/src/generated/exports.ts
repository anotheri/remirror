/**
 * @module
 *
 * DO NOT EDIT: AUTO-GENERATED FILE
 * @see `@remirror/playground/scripts/import-remirror.ts`
 */

import { loadJson } from 'json.macro';

import type { DtsCache } from '../vendor/type-acquisition';

// Use a babel macro to load the json file.
const { dtsCache, typeDefinitionMap } = loadJson('./dts.json');

/**
 * The pre populated cache of module names to their stringified package.json
 * file.
 */
export const TYPE_DEFINITION_MAP: Record<
  string,
  { id: string; packageJson: string }
> = typeDefinitionMap;

/**
 * The pre populated cache of definition files.
 */
export const DTS_CACHE: DtsCache = dtsCache;
