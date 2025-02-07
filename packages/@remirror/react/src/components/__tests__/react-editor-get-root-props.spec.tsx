import { axe } from 'jest-axe';
import React, { forwardRef, FunctionComponent, Ref, RefAttributes } from 'react';

import { createReactManager, RenderResult, strictRender } from '@remirror/testing/react';

import { ReactEditor } from '../react-editor';

const mock = jest.fn();
const CustomRoot: FunctionComponent<RefAttributes<HTMLDivElement>> = forwardRef((props, ref) => {
  mock(ref);
  return <div {...props} ref={ref} />;
});

test('supports a custom root element', () => {
  strictRender(
    <ReactEditor manager={createReactManager([])}>
      {({ getRootProps }) => {
        return <CustomRoot {...getRootProps()} />;
      }}
    </ReactEditor>,
  );

  expect(mock).toHaveBeenCalledWith(expect.any(Function));
});

test('supports a custom ref label and passed props through', () => {
  function Cmp(props: { customRef: Ref<HTMLDivElement> }) {
    mock(props);
    return <div ref={props.customRef} />;
  }

  const testProp = 'test';
  strictRender(
    <ReactEditor manager={createReactManager([])}>
      {({ getRootProps }) => {
        return <Cmp {...getRootProps({ refKey: 'customRef', testProp })} />;
      }}
    </ReactEditor>,
  );

  expect(mock.mock.calls[0][0].customRef).toBeFunction();
  expect(mock.mock.calls[0][0].testProp).toBe(testProp);
});

describe('nestedRootProps', () => {
  let result: RenderResult;

  beforeEach(() => {
    result = strictRender(
      <main>
        <ReactEditor manager={createReactManager([])} label='Editor'>
          {({ getRootProps }) => {
            return (
              <div>
                <div {...getRootProps()} id='nested-div'>
                  <div id='wrapped-div'>Wrapped text</div>
                </div>
              </div>
            );
          }}
        </ReactEditor>
      </main>,
    );
  });

  it('should not duplicate nodes', () => {
    const { baseElement } = result;

    expect(baseElement.querySelectorAll('#nested-div')).toHaveLength(1);
  });

  it('renders the nested elements', () => {
    const { baseElement, getByRole } = result;
    const innerLabel = baseElement.querySelector('#wrapped-div') as HTMLElement;
    const wrapper = baseElement.querySelector('#nested-div');

    expect(innerLabel).toBeVisible();
    expect(wrapper!.childElementCount).toBe(2);
    expect(wrapper).toContainElement(innerLabel);
    expect(wrapper).toContainElement(getByRole('textbox'));
  });

  it('retains accessibility', async () => {
    await expect(axe(result.container.outerHTML)).resolves.toHaveNoViolations();
  });
});
