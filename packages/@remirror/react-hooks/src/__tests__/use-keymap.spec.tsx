import { RemirrorTestChain } from 'jest-remirror';
import React, { useState } from 'react';

import {
  AnyExtension,
  ExtensionPriority,
  fromHtml,
  RemirrorEventListener,
  toHtml,
} from '@remirror/core';
import {
  act,
  createReactManager,
  DefaultEditor,
  RemirrorProvider,
  strictRender,
  useManager,
} from '@remirror/testing/react';

import { useKeymap } from '../use-keymap';

describe('useKeymap', () => {
  it('captures keymaps in correct order', () => {
    const editor = RemirrorTestChain.create(createReactManager([]));
    const mock = jest.fn((_: number) => false);
    const HooksComponent = () => {
      useKeymap({ Enter: () => mock(1) });
      useKeymap({ Enter: () => mock(2) });
      useKeymap({ Enter: () => mock(3) });
      useKeymap({ Enter: () => mock(4) });

      return null;
    };

    strictRender(
      <RemirrorProvider manager={editor.manager}>
        <DefaultEditor />
        <HooksComponent />
      </RemirrorProvider>,
    );

    act(() => {
      editor.press('Enter');
    });

    expect(mock.mock.calls).toEqual([[1], [2], [3], [4]]);
  });

  it('prioritizes the keymaps', () => {
    const editor = RemirrorTestChain.create(createReactManager([]));
    const mock = jest.fn((_: number) => false);
    const HooksComponent = () => {
      useKeymap({ Enter: () => mock(1) }, ExtensionPriority.Default);
      useKeymap({ Enter: () => mock(2) }, ExtensionPriority.Highest);
      useKeymap({ Enter: () => mock(3) }, ExtensionPriority.Medium);
      useKeymap({ Enter: () => mock(4) }, ExtensionPriority.Critical);

      return null;
    };

    strictRender(
      <RemirrorProvider manager={editor.manager}>
        <DefaultEditor />
        <HooksComponent />
      </RemirrorProvider>,
    );

    act(() => {
      editor.press('Enter');
    });

    expect(mock.mock.calls).toEqual([[4], [2], [3], [1]]);
  });

  it('responds to events in strict mode with a controlled editor', () => {
    const chain = RemirrorTestChain.create(createReactManager([]));
    const mockSubmit = jest.fn();

    const Component = () => {
      const manager = useManager(chain.manager);

      const initialValue = manager.createState({
        content: '<p>test</p>',
        selection: 'end',
        stringHandler: fromHtml,
      });

      const [value, setValue] = useState(initialValue);

      function onSubmit() {
        mockSubmit(toHtml({ node: value.doc, schema: value.schema }));
      }

      const onChange: RemirrorEventListener<AnyExtension> = ({ state }) => {
        setValue(state);
      };

      return (
        <RemirrorProvider manager={manager} onChange={onChange} value={value}>
          <div id='1'>
            <DefaultEditor />
            <KeymapComponent onSubmit={onSubmit} />
          </div>
        </RemirrorProvider>
      );
    };

    interface TextEditorProps {
      onSubmit: () => void;
    }

    const KeymapComponent = (props: TextEditorProps) => {
      useKeymap({
        Enter: () => {
          props.onSubmit();
          return false;
        },
      });

      return null;
    };

    strictRender(<Component />);
    act(() => {
      chain.press('Enter');
    });

    expect(mockSubmit).toHaveBeenCalledTimes(1);

    // NOTE: the reason this doesn't match the dom value is that the keymap
    // intercepts the call before the updated state. The value has not yet been
    // updated.
    expect(mockSubmit).toHaveBeenCalledWith('<p>test</p>');

    expect(chain.dom.innerHTML).toMatchInlineSnapshot(`
      <p>
        test
      </p>
      <p>
        <br>
      </p>
    `);
  });
});
