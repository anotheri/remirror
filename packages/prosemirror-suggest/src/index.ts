/**
 * Primitives for building your prosemirror suggestion and autocomplete
 * functionality.
 *
 * @packageDocumentation
 */

export type { SuggestState } from './suggest-plugin';
export { addSuggester, getSuggestPluginState, removeSuggester, suggest } from './suggest-plugin';

export type {
  AddIgnoredParameter,
  CompareMatchParameter,
  DocChangedParameter,
  RangeWithCursor,
  MatchValue,
  ReasonMatchParameter,
  ReasonParameter,
  RemoveIgnoredParameter,
  SuggestChangeHandler,
  SuggestChangeHandlerParameter,
  SuggestIgnoreParameter,
  SuggestMarkParameter,
  SuggestReasonMap,
  SuggestMatch,
  SuggestStateMatchParameter,
  SuggestMatchWithReason,
  Suggester,
  SuggesterParameter,
} from './suggest-types';
export { ChangeReason, ExitReason } from './suggest-types';

export {
  isChange,
  isChangeReason,
  isEntry,
  isExit,
  isExitReason,
  isInvalidSplitReason,
  isJump,
  isJumpReason,
  isMove,
  isRemovedReason,
  isSelectionExitReason,
  isSplitReason,
  isValidMatch,
  selectionOutsideMatch,
} from './suggest-predicates';

export {
  createRegexFromSuggester,
  getSuggesterWithDefaults,
  DEFAULT_SUGGESTER,
} from './suggest-utils';
