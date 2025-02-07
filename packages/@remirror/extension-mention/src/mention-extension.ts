import {
  ApplySchemaAttributes,
  bool,
  CommandFunction,
  ErrorConstant,
  extensionDecorator,
  ExtensionTag,
  getMarkRange,
  getMatchString,
  Handler,
  invariant,
  isElementDomNode,
  isMarkActive,
  isPlainObject,
  isString,
  MarkAttributes,
  MarkExtension,
  MarkExtensionSpec,
  markPasteRule,
  pick,
  ProsemirrorAttributes,
  ProsemirrorPlugin,
  RangeParameter,
  removeMark,
  replaceText,
  Static,
} from '@remirror/core';
import {
  createRegexFromSuggester,
  DEFAULT_SUGGESTER,
  isInvalidSplitReason,
  isRemovedReason,
  isSelectionExitReason,
  isSplitReason,
  MatchValue,
  RangeWithCursor,
  SuggestChangeHandlerParameter,
  Suggester,
} from '@remirror/pm/suggest';

/**
 * The static settings passed into a mention
 */
export interface MentionOptions
  extends Pick<
    Suggester,
    'invalidNodes' | 'validNodes' | 'invalidMarks' | 'validMarks' | 'isValidPosition'
  > {
  /**
   * Provide a custom tag for the mention
   */
  mentionTag?: Static<string>;

  /**
   * Provide the custom matchers that will be used to match mention text in the
   * editor.
   */
  matchers: Static<MentionExtensionMatcher[]>;

  /**
   * Text to append after the mention has been added.
   *
   * **NOTE**: If you're using whitespace characters but it doesn't seem to work
   * for you make sure you're using the css provided in `@remirror/styles`.
   *
   * The `white-space: pre-wrap;` is what allows editors to add space characters
   * at the end of a section.
   *
   * @default ''
   */
  appendText?: string;

  /**
   * Tag for the prosemirror decoration which wraps an active match.
   *
   * @default 'span'
   */
  suggestTag?: string;

  /**
   * When true, decorations are not created when this mention is first being
   * created or edited.
   */
  disableDecorations?: boolean;

  /**
   * Called whenever a suggestion becomes active or changes in any way.
   *
   * @remarks
   *
   * It receives a parameters object with the `reason` for the change for more
   * granular control.
   *
   * The second parameter is a function that can be called to handle exits
   * automatically. This is useful if you're mention can be any possible value,
   * e.g. a `#hashtag`. Call it with the optional attributes to automatically
   * create a mention.
   *
   * @default () => void
   */
  onChange?: Handler<MentionChangeHandler>;
}

/**
 * The mention extension wraps mentions as a prosemirror mark. It allows for
 * fluid social experiences to be built. The implementation was inspired by the
 * way twitter and similar social sites allows mentions to be edited after
 * they've been created.
 *
 * @remarks
 *
 * Mentions have the following features
 * - An activation character or regex pattern which you define.
 * - A min number of characters before mentions are suggested
 * - Ability to exclude matching character.
 * - Ability to wrap content in a decoration which excludes mentions from being
 *   suggested.
 * - Decorations for in-progress mentions
 */
@extensionDecorator<MentionOptions>({
  defaultOptions: {
    mentionTag: 'a' as const,
    matchers: [],
    appendText: '',
    suggestTag: 'a' as const,
    disableDecorations: false,
    invalidMarks: [],
    invalidNodes: [],
    isValidPosition: () => true,
    validMarks: null,
    validNodes: null,
  },
  handlerKeys: ['onChange'],
  staticKeys: ['matchers', 'mentionTag'],
})
export class MentionExtension extends MarkExtension<MentionOptions> {
  get name() {
    return 'mention' as const;
  }

  /**
   * Tag this as a behavior influencing mark.
   */
  readonly tags = [ExtensionTag.Behavior];

  createMarkSpec(extra: ApplySchemaAttributes): MarkExtensionSpec {
    const dataAttributeId = 'data-mention-id';
    const dataAttributeName = 'data-mention-name';

    return {
      attrs: {
        ...extra.defaults(),
        id: {},
        label: {},
        name: {},
      },
      excludes: '_',
      inclusive: false,
      parseDOM: [
        {
          tag: `${this.options.mentionTag}[${dataAttributeId}]`,
          getAttrs: (element) => {
            if (!isElementDomNode(element)) {
              return false;
            }

            const id = element.getAttribute(dataAttributeId);
            const name = element.getAttribute(dataAttributeName);
            const label = element.textContent;
            return { ...extra.parse(element), id, label, name };
          },
        },
      ],
      toDOM: (mark) => {
        const {
          label: _,
          id,
          name,
          replacementType,
          range,
          ...attributes
        } = mark.attrs as Required<NamedMentionExtensionAttributes>;
        const matcher = this.options.matchers.find((matcher) => matcher.name === name);

        const mentionClassName = matcher
          ? matcher.mentionClassName ?? DEFAULT_MATCHER.mentionClassName
          : DEFAULT_MATCHER.mentionClassName;

        return [
          this.options.mentionTag,
          {
            ...extra.dom(mark),
            ...attributes,
            class: name ? `${mentionClassName} ${mentionClassName}-${name}` : mentionClassName,
            [dataAttributeId]: id,
            [dataAttributeName]: name,
          },
          0,
        ];
      },
    };
  }

  createCommands() {
    const commands = {
      /**
       * This is the command which can be called from the `onChange` handler to
       * automatically handle exits for you. It decides whether a mention should
       * be updated, removed or created and also handles invalid splits.
       *
       * It does nothing for changes and only acts when an exit occurred.
       *
       * @param handler - the parameter that was passed through to the `onChange`
       * handler.
       * @param attrs - the options which set the values that will be used (in
       * case you want to override the defaults).
       */
      mentionExitHandler: (
        handler: SuggestChangeHandlerParameter,
        attrs: MentionChangeHandlerCommandAttributes = {},
      ): CommandFunction => (parameter) => {
        const reason = handler.exitReason ?? handler.changeReason;

        // Get boolean flags of the reason for this exit.
        const isInvalid = isInvalidSplitReason(reason);
        const isRemoved = isRemovedReason(reason);

        if (isInvalid || isRemoved) {
          handler.setMarkRemoved();

          try {
            // This might fail when a deletion has taken place.
            return isInvalid && commands.removeMention({ range: handler.range })(parameter);
          } catch {
            // This happens when removing the mention failed. If you select the
            // whole document and delete while there are mentions active then
            // this catch block will activate. It's not harmful, just prevents
            // you seeing `RangeError: Position X out of range`. I'll leave it
            // like this until more is known about the impact. Please create an
            // issue if this blocks you in some way.
            //
            // TODO test if this still fails.
            return true;
          }
        }

        const { tr } = parameter;
        const { range, text, query, name } = handler;
        const { from, to } = range;

        // Check whether the mention marks is currently active at the provided
        // for the command.
        const isActive = isMarkActive({ from, to, type: this.type, trState: tr });

        // Use the correct command, either update when currently active or
        // create when not active.
        const command = isActive ? commands.updateMention : commands.createMention;

        // Destructure the `attrs` and using the defaults.
        const {
          replacementType = isSplitReason(reason) ? 'partial' : 'full',
          id = query[replacementType],
          label = text[replacementType],
          appendText = this.options.appendText,
          ...rest
        } = attrs;

        // Make sure to preserve the selection, if the reason for the exit was a
        // cursor movement and not due to text being added to the document.
        const keepSelection = isSelectionExitReason(reason);

        return command({
          name,
          id,
          label,
          appendText,
          replacementType,
          range,
          keepSelection,
          ...rest,
        })(parameter);
      },
      /**
       * Create a new mention
       */
      createMention: this.createMention(false),

      /**
       * Update an existing mention.
       */
      updateMention: this.createMention(true),

      /**
       * Remove the mention(s) at the current selection or provided range.
       */
      removeMention: ({ range }: Partial<RangeParameter> = {}) =>
        removeMark({ type: this.type, expand: true, range }),
    };

    return commands;
  }

  createPasteRules(): ProsemirrorPlugin[] {
    return this.options.matchers.map((matcher) => {
      const { startOfLine, char, supportedCharacters, name, matchOffset } = {
        ...DEFAULT_MATCHER,
        ...matcher,
      };

      const regexp = new RegExp(
        `(${
          createRegexFromSuggester({
            char,
            matchOffset,
            startOfLine,
            supportedCharacters,
            captureChar: true,
          }).source
        })`,
        'g',
      );

      return markPasteRule({
        regexp,
        type: this.type,
        getAttributes: (string) => ({
          id: getMatchString(string.slice(string[2].length, string.length)),
          label: getMatchString(string),
          name,
        }),
      });
    });
  }

  /**
   * Create the suggesters from the matchers that were passed into the editor.
   */
  createSuggesters(): Suggester[] {
    const options = pick(this.options, [
      'invalidMarks',
      'invalidNodes',
      'isValidPosition',
      'validMarks',
      'validNodes',
      'suggestTag',
      'disableDecorations',
    ]);

    return this.options.matchers.map<Suggester>((matcher) => {
      return {
        ...DEFAULT_MATCHER,
        ...options,
        ...matcher,
        onChange: (parameter) => {
          const { mentionExitHandler } = this.store.getCommands();

          function command(attrs: MentionChangeHandlerCommandAttributes = {}) {
            mentionExitHandler(parameter, attrs);
          }

          this.options.onChange(parameter, command);
        },
      };
    });
  }

  /**
   * The factory method for mention commands to update and create new mentions.
   */
  private createMention(shouldUpdate: boolean) {
    return (config: NamedMentionExtensionAttributes & KeepSelectionParameter): CommandFunction => {
      invariant(isValidMentionAttributes(config), {
        message: 'Invalid configuration attributes passed to the MentionExtension command.',
      });

      const { range, appendText, replacementType, keepSelection, ...attributes } = config;
      let name = attributes.name;

      if (!name) {
        invariant(this.options.matchers.length < 2, {
          code: ErrorConstant.EXTENSION,
          message:
            'The MentionExtension command must specify a name since there are multiple matchers configured',
        });

        name = this.options.matchers[0].name;
      }

      const allowedNames = this.options.matchers.map(({ name }) => name);

      invariant(allowedNames.includes(name), {
        code: ErrorConstant.EXTENSION,
        message: `The name '${name}' specified for this command is invalid. Please choose from: ${JSON.stringify(
          allowedNames,
        )}.`,
      });

      const matcher = getMatcher(name, this.options.matchers);

      invariant(matcher, {
        code: ErrorConstant.EXTENSION,
        message: `Mentions matcher not found for name ${name}.`,
      });

      return (parameter) => {
        const { tr } = parameter;
        const { from, to } = {
          from: range?.from ?? tr.selection.from,
          to: range?.cursor ?? tr.selection.to,
        };

        if (shouldUpdate) {
          // Remove mark at previous position
          let { oldFrom, oldTo } = { oldFrom: from, oldTo: range ? range.to : to };
          const $oldTo = tr.doc.resolve(oldTo);

          ({ from: oldFrom, to: oldTo } = getMarkRange($oldTo, this.type) || {
            from: oldFrom,
            to: oldTo,
          });

          tr.removeMark(oldFrom, oldTo, this.type).setMeta('addToHistory', false);

          // Remove mark at current position
          const $newTo = tr.selection.$from;
          const { from: newFrom, to: newTo } = getMarkRange($newTo, this.type) || {
            from: $newTo.pos,
            to: $newTo.pos,
          };

          tr.removeMark(newFrom, newTo, this.type).setMeta('addToHistory', false);
        }

        return replaceText({
          keepSelection,
          type: this.type,
          attrs: { ...attributes, name },
          appendText: getAppendText(appendText, matcher.appendText),
          range: range ? { from, to: replacementType === 'full' ? range.to || to : to } : undefined,
          content: attributes.label,
        })(parameter);
      };
    };
  }
}

export interface OptionalMentionExtensionParameter {
  /**
   * The text to append to the replacement.
   *
   * @default ''
   */
  appendText?: string;

  /**
   * The range of the requested selection.
   */
  range?: RangeWithCursor;

  /**
   * Whether to replace the whole match (`full`) or just the part up until the
   * cursor (`partial`).
   */
  replacementType?: keyof MatchValue;
}

interface KeepSelectionParameter {
  /**
   * Whether to preserve the original selection after the replacement has
   * occurred.
   */
  keepSelection?: boolean;
}

/**
 * The attrs that will be added to the node. ID and label are plucked and used
 * while attributes like href and role can be assigned as desired.
 */
export type MentionExtensionAttributes = MarkAttributes<
  OptionalMentionExtensionParameter & {
    /**
     * A unique identifier for the suggesters node
     */
    id: string;

    /**
     * The text to be placed within the suggesters node
     */
    label: string;
  }
>;

export type NamedMentionExtensionAttributes = MentionChangeHandlerCommandAttributes & {
  /**
   * The identifying name for the active matcher. This is stored as an
   * attribute on the HTML that will be produced
   */
  name: string;
};

/**
 * The options for the matchers which can be created by this extension.
 */
export interface MentionExtensionMatcher
  extends Pick<
    Suggester,
    | 'char'
    | 'name'
    | 'startOfLine'
    | 'supportedCharacters'
    | 'validPrefixCharacters'
    | 'invalidPrefixCharacters'
    | 'matchOffset'
    | 'suggestClassName'
  > {
  /**
   * Provide customs class names for the completed mention
   */
  mentionClassName?: string;

  /**
   * Text to append after the suggestion has been added.
   *
   * @default ''
   */
  appendText?: string;
}

export type MentionChangeHandlerCommand = (attrs?: MentionChangeHandlerCommandAttributes) => void;

/**
 * A handler that will be called whenever the the active matchers are updated or
 * exited. The second argument which is the exit command is a function which is
 * only available when the matching suggester has been exited.
 */
export type MentionChangeHandler = (
  handlerState: SuggestChangeHandlerParameter,
  command: (attrs?: MentionChangeHandlerCommandAttributes) => void,
) => void;

/**
 * The dynamic properties used to change the behavior of the mentions created.
 */
export type MentionChangeHandlerCommandAttributes = ProsemirrorAttributes<
  Partial<Pick<MentionExtensionAttributes, 'appendText' | 'replacementType'>> & {
    /**
     * The ID to apply the mention.
     *
     * @default query.full
     */
    id?: string;

    /**
     * The text that is displayed within the mention bounds.
     *
     * @default text.full
     */
    label?: string;
  }
>;

/**
 * The default matcher to use when none is provided in options
 */
const DEFAULT_MATCHER = {
  ...pick(DEFAULT_SUGGESTER, [
    'startOfLine',
    'supportedCharacters',
    'validPrefixCharacters',
    'invalidPrefixCharacters',
    'suggestClassName',
  ]),
  appendText: '',
  matchOffset: 1,
  mentionClassName: 'mention',
};

/**
 * Check that the attributes exist and are valid for the mention update command
 * method.
 */
function isValidMentionAttributes(attributes: unknown): attributes is MentionExtensionAttributes {
  return bool(attributes && isPlainObject(attributes) && attributes.id && attributes.label);
}

/**
 * Gets the matcher from the list of matchers if it exists.
 *
 * @param name - the name of the matcher to find
 * @param matchers - the list of matchers to search through
 */
function getMatcher(name: string, matchers: MentionExtensionMatcher[]) {
  const matcher = matchers.find((matcher) => matcher.name === name);
  return matcher ? { ...DEFAULT_MATCHER, ...matcher } : undefined;
}

/**
 * Get the append text value which needs to be handled carefully since it can
 * also be an empty string.
 */
function getAppendText(preferred: string | undefined, fallback: string | undefined) {
  if (isString(preferred)) {
    return preferred;
  }

  if (isString(fallback)) {
    return fallback;
  }

  return DEFAULT_MATCHER.appendText;
}
