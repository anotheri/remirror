/** @jsx jsx */
/**
 * @packageDocumentation
 *
 * The following code has been taken from the unfinished development of
 * react-split-pane. I'm putting it here because I want to use it in a
 * TypeScript library and also convert the underlying functionality to use
 * hooks.
 */

import { jsx } from '@emotion/core';
import styled from '@emotion/styled';
import {
  Children,
  CSSProperties,
  FC,
  LegacyRef,
  MouseEvent,
  PropsWithChildren,
  ReactElement,
  ReactNode,
  RefCallback,
  TouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  invariant,
  isArray,
  isNumber,
  isObject,
  isString,
  isUndefined,
  uniqueArray,
} from 'remirror/core';
import { isValidElement } from 'remirror/react/utils';

const DEFAULT_PANE_SIZE = '1';
const DEFAULT_PANE_MIN_SIZE = '0';
const DEFAULT_PANE_MAX_SIZE = '100%';

interface SplitPaneProps {
  className?: string;

  /**
   * @default 'vertical'
   */
  split?: Split;

  /**
   * @default 1
   */
  resizerSize?: number;

  /**
   * @default true
   */
  allowResize?: boolean;
  onChange?: (sizes: string[]) => void;
  onResizeStart?: () => void;
  onResizeEnd?: (sizes: string[]) => void;
}

interface DimensionsSnapshot {
  resizerSize: number;
  paneDimensions: DOMRect[];
  splitPaneSizePx: number;
  minSizesPx: number[];
  maxSizesPx: number[];
  sizesPx: number[];
}

interface GetDimensionSnapshotOptions {
  children: ReactNode;
  splitPane: HTMLElement;
  split: Split;
  paneElements: HTMLElement[];
  previousResizersSize: number;
}

interface Data {
  resizerIndex: number;
  dimensionsSnapshot: DimensionsSnapshot;
  startClientX: number;
  startClientY: number;
}

/**
 * The main component export which holds the panes that form the layout.
 */
export const SplitPane: FC<SplitPaneProps> = (props) => {
  const {
    children,
    onChange,
    onResizeEnd,
    onResizeStart,
    className,
    allowResize = true,
    resizerSize = 1,
    split = 'vertical',
  } = props;

  // This tracks the ref of this split pane component.
  const splitPaneRef = useRef<HTMLDivElement>(null);

  // A ref which tracks the positional data for the different resizers.
  const dataRef = useRef<Data>();

  // The pane elements list.
  const paneElementsRef = useRef<HTMLElement[]>([]);

  // State variable to keep track of the sizes for each rendered child.
  const [sizes, setSizes] = useState<string[]>(() => getPanePropSizes(props.children));

  const onMove = useCallback(
    (clientX: number, clientY: number) => {
      const data = dataRef.current;

      if (!data) {
        return;
      }

      const { dimensionsSnapshot, resizerIndex, startClientX, startClientY } = data;
      const {
        sizesPx,
        minSizesPx,
        maxSizesPx,
        splitPaneSizePx,
        paneDimensions,
      } = dimensionsSnapshot;

      const sizeDimension = split === 'vertical' ? 'width' : 'height';
      const primary = paneDimensions[resizerIndex];
      const secondary = paneDimensions[resizerIndex + 1];
      const maxSize = primary[sizeDimension] + secondary[sizeDimension];

      const primaryMinSizePx = minSizesPx[resizerIndex];
      const secondaryMinSizePx = minSizesPx[resizerIndex + 1];
      const primaryMaxSizePx = Math.min(maxSizesPx[resizerIndex], maxSize);
      const secondaryMaxSizePx = Math.min(maxSizesPx[resizerIndex + 1], maxSize);

      const moveOffset = split === 'vertical' ? startClientX - clientX : startClientY - clientY;

      let primarySizePx = primary[sizeDimension] - moveOffset;
      let secondarySizePx = secondary[sizeDimension] + moveOffset;

      let primaryHasReachedLimit = false;
      let secondaryHasReachedLimit = false;

      if (primarySizePx < primaryMinSizePx) {
        primarySizePx = primaryMinSizePx;
        primaryHasReachedLimit = true;
      } else if (primarySizePx > primaryMaxSizePx) {
        primarySizePx = primaryMaxSizePx;
        primaryHasReachedLimit = true;
      }

      if (secondarySizePx < secondaryMinSizePx) {
        secondarySizePx = secondaryMinSizePx;
        secondaryHasReachedLimit = true;
      } else if (secondarySizePx > secondaryMaxSizePx) {
        secondarySizePx = secondaryMaxSizePx;
        secondaryHasReachedLimit = true;
      }

      if (primaryHasReachedLimit) {
        secondarySizePx = primary[sizeDimension] + secondary[sizeDimension] - primarySizePx;
      } else if (secondaryHasReachedLimit) {
        primarySizePx = primary[sizeDimension] + secondary[sizeDimension] - secondarySizePx;
      }

      sizesPx[resizerIndex] = primarySizePx;
      sizesPx[resizerIndex + 1] = secondarySizePx;

      let sizesClone = [...sizes];
      let updateRatio;

      [primarySizePx, secondarySizePx].forEach((paneSize, idx) => {
        const unit = getUnit(sizesClone[resizerIndex + idx]);

        if (unit !== 'ratio') {
          sizesClone[resizerIndex + idx] = convertToUnit(paneSize, unit, splitPaneSizePx);
        } else {
          updateRatio = true;
        }
      });

      if (updateRatio) {
        let ratioCount = 0;
        let lastRatioIndex = 0;

        sizesClone = sizesClone.map((size, index) => {
          if (getUnit(size) === 'ratio') {
            ratioCount++;
            lastRatioIndex = index;

            return convertToUnit(sizesPx[index], 'ratio', splitPaneSizePx);
          }

          return size;
        });

        if (ratioCount === 1) {
          sizesClone[lastRatioIndex] = '1';
        }
      }

      onChange?.(sizesClone);
      setSizes(() => sizesClone);
    },
    [onChange, sizes, split],
  );

  const onMouseMove = useCallback(
    (event: globalThis.MouseEvent) => {
      event.preventDefault();

      onMove(event.clientX, event.clientY);
    },
    [onMove],
  );

  const onTouchMove = useCallback(
    (event: globalThis.TouchEvent) => {
      const { clientX, clientY } = event.touches[0];

      event.preventDefault();
      onMove(clientX, clientY);
    },
    [onMove],
  );

  const onMouseUp: EventListener = useCallback(
    (event) => {
      event.preventDefault();

      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousemove', onMouseMove);

      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onMouseUp);
      document.addEventListener('touchcancel', onMouseUp);

      onResizeEnd?.(sizes);
    },
    [onMouseMove, onResizeEnd, onTouchMove, sizes],
  );

  const onDown = useCallback(
    (resizerIndex: number, clientX: number, clientY: number) => {
      if (!allowResize || !isNumber(resizerSize) || !splitPaneRef.current) {
        return;
      }

      dataRef.current = {
        resizerIndex,
        startClientX: clientX,
        startClientY: clientY,
        dimensionsSnapshot: getDimensionsSnapshot({
          children,
          paneElements: paneElementsRef.current,
          previousResizersSize: resizerSize,
          split,
          splitPane: splitPaneRef.current,
        }),
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);

      document.addEventListener('touchmove', onTouchMove);
      document.addEventListener('touchend', onMouseUp);
      document.addEventListener('touchcancel', onMouseUp);

      onResizeStart?.();
    },
    [allowResize, children, onMouseMove, onMouseUp, onResizeStart, onTouchMove, resizerSize, split],
  );

  const onMouseDown: MouseEventHandler = useCallback(
    (event, index) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      onDown(index, event.clientX, event.clientY);
    },
    [onDown],
  );

  const onTouchStart: TouchEventHandler = useCallback(
    (event, index) => {
      const { clientX, clientY } = event.touches[0];

      event.preventDefault();
      onDown(index, clientX, clientY);
    },
    [onDown],
  );

  // This hook handles the cleanup when the component unmounts.
  useEffect(() => {
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onMouseUp);
    };
  }, [onMouseMove, onMouseUp, onTouchMove]);

  // Update the sizes on each render.
  useEffect(() => {
    setSizes(() => getPanePropSizes(props.children));
  }, [props.children]);

  const setPaneRef = useCallback((idx, el) => {
    paneElementsRef.current[idx] = el;
  }, []);

  // The component that will be rendered
  const Component = split === 'vertical' ? RowStyle : ColumnStyle;

  // Gather the non null children to create all the child element.s
  const notNullChildren = removeNullChildren(props.children);
  const resizersSize = getResizersSize(notNullChildren, resizerSize);

  // The holder for the element which will be rendered.
  const elements: JSX.Element[] = [];

  for (const [index, child] of notNullChildren.entries()) {
    const resizerIndex = index - 1;
    const paneProps = {
      className,
      index: index,
      'data-type': 'Pane',
      split: split,
      key: `Pane-${index}`,
      innerRef: setPaneRef,
      resizersSize,
      size: sizes[index],
    };

    const pane = isPaneElement(child) ? (
      cloneElement(child, paneProps)
    ) : (
      <Pane {...paneProps}>{child}</Pane>
    );

    // When this is the first element being added don't render the `Resizer`.
    const added =
      elements.length === 0
        ? [pane]
        : [
            <Resizer
              index={resizerIndex}
              key={`Resizer-${resizerIndex}`}
              split={split}
              onMouseDown={onMouseDown}
              onTouchStart={onTouchStart}
            />,
            pane,
          ];

    elements.push(...added);
  }

  return (
    <Component className={className} data-type='SplitPane' data-split={split} ref={splitPaneRef}>
      {elements}
    </Component>
  );
};

const Wrapper = styled.div`
  background: #000;
  opacity: 0.2;
  z-index: 1;
  box-sizing: border-box;
  background-clip: padding-box;

  :hover {
    transition: all 2s ease;
  }
`;

const HorizontalWrapper = styled(Wrapper)`
  height: 11px;
  margin: -5px 0;
  border-top: 5px solid rgba(255, 255, 255, 0);
  border-bottom: 5px solid rgba(255, 255, 255, 0);
  cursor: row-resize;
  width: 100%;

  :hover {
    border-top: 5px solid rgba(0, 0, 0, 0.5);
    border-bottom: 5px solid rgba(0, 0, 0, 0.5);
  }

  .disabled {
    cursor: not-allowed;
  }
  .disabled:hover {
    border-color: transparent;
  }
`;

const VerticalWrapper = styled(Wrapper)`
  width: 11px;
  margin: 0 -5px;
  border-left: 5px solid rgba(255, 255, 255, 0);
  border-right: 5px solid rgba(255, 255, 255, 0);
  cursor: col-resize;

  :hover {
    border-left: 5px solid rgba(0, 0, 0, 0.5);
    border-right: 5px solid rgba(0, 0, 0, 0.5);
  }

  .disabled {
    cursor: not-allowed;
  }

  .disabled:hover {
    border-color: transparent;
  }
`;

type MouseEventHandler = (
  event: MouseEvent<HTMLElement, globalThis.MouseEvent>,
  index: number,
) => void;
type TouchEventHandler = (event: TouchEvent<HTMLElement>, index: number) => void;

interface ResizerProps {
  index: number;
  split?: Split;
  onClick?: MouseEventHandler;
  onDoubleClick?: MouseEventHandler;
  onMouseDown?: MouseEventHandler;
  onTouchEnd?: TouchEventHandler;
  onTouchStart?: TouchEventHandler;
}

type DivProps = JSX.IntrinsicElements['div'];

/**
 * The component which renders the `Resizer`.
 */
const Resizer: FC<ResizerProps> = (props) => {
  type WrapperProps = Omit<DivProps, 'ref'> & { 'data-attribute': string; 'data-type': string };

  const {
    index,
    split = 'vertical',
    onClick = () => {},
    onDoubleClick = () => {},
    onMouseDown = () => {},
    onTouchEnd = () => {},
    onTouchStart = () => {},
  } = props;

  const wrapperProps: WrapperProps = useMemo(
    () => ({
      'data-attribute': split,
      'data-type': 'Resizer',
      onMouseDown: (event) => onMouseDown(event, index),
      onTouchStart: (event) => {
        event.preventDefault();
        onTouchStart(event, index);
      },
      onTouchEnd: (event) => {
        event.preventDefault();
        onTouchEnd(event, index);
      },
      onClick: (event) => {
        if (onClick) {
          event.preventDefault();
          onClick(event, index);
        }
      },
      onDoubleClick: (event) => {
        if (onDoubleClick) {
          event.preventDefault();
          onDoubleClick(event, index);
        }
      },
    }),
    [index, onClick, onDoubleClick, onMouseDown, onTouchEnd, onTouchStart, split],
  );

  return split === 'vertical' ? (
    <VerticalWrapper {...wrapperProps} />
  ) : (
    <HorizontalWrapper {...wrapperProps} />
  );
};

interface PaneProps extends Partial<PaneStyle> {
  innerRef?: (index: number, element: HTMLElement) => void;
  index?: number;
  className?: string;
}

/**
 * The component which renders the pane.
 */
export const Pane: FC<PaneProps> = (props) => {
  const {
    index,
    innerRef,
    children,
    className,
    initialSize = '1',
    split = 'vertical',
    minSize = '0',
    maxSize = '100%',
    resizersSize,
    size,
  } = props;

  const setRef: RefCallback<HTMLElement> = useCallback(
    (element) => {
      if (!element || !isNumber(index)) {
        return;
      }

      innerRef?.(index, element);
    },
    [index, innerRef],
  );

  return (
    <div
      className={className}
      style={createPaneStyle({ initialSize, maxSize, minSize, resizersSize, split, size })}
      ref={setRef}
    >
      {children}
    </div>
  );
};

interface PaneStyle {
  split: Split;
  initialSize: number | string;
  size?: number | string;
  minSize: string | number;
  maxSize: string | number;
  resizersSize?: string | number;
}

type Split = 'vertical' | 'horizontal';

/**
 * Convert a provided string and size ratio into a valid css string.
 */
function convert(str: string, size: number) {
  const tokens = str.match(/(\d+)([%px|]*)/);
  const [, value, unit] = tokens ?? [];

  return toPx(value, unit, size);
}

/**
 * Convert a string to a pixel value.
 */
function toPx(value: string, unit = 'px', size: number) {
  switch (unit) {
    case '%':
      return +((size * Number.parseFloat(value)) / 100).toFixed(2);

    default:
      return +value;
  }
}

/**
 * Clones an element while also enabling the css prop on jsx elements at the same time.
 * This is used for emotion which needs to inject the css property which React.cloneElement doesn't support.
 *
 * @param element - the element to clone
 * @param props - the props to pass through to the cloned element
 * @param rest - the children of the cloned element
 *
 * @returns a cloned react element with builtin support for the emotion `css` props
 */
function cloneElement<Props extends PropsWithChildren<{ ref?: LegacyRef<any> }> = any>(
  element: ReactElement<Props>,
  props: Props,
  ...rest: ReactNode[]
) {
  const children = uniqueArray([
    ...(isArray(props.children) ? props.children : props.children ? [props.children] : []),
    ...rest,
  ]);

  return jsx(
    element.type,
    {
      key: element.key,
      ref: element.props.ref,
      ...element.props,
      ...props,
    },
    ...children,
  );
}

/**
 * Removes all the null children.
 */
function removeNullChildren(children: ReactNode) {
  return Children.toArray(children).filter((c) => c);
}

type Unit = 'px' | '%' | 'ratio';

function getUnit(size: string | number): Unit {
  return isString(size)
    ? size.endsWith('px')
      ? 'px'
      : size.endsWith('%')
      ? '%'
      : 'ratio'
    : 'ratio';
}

function convertSizeToCssValue(value: string | number, resizersSize?: string | number) {
  if (getUnit(value) !== '%' || isNumber(value)) {
    return value;
  }

  if (!resizersSize) {
    return value;
  }

  const idx = value.search('%');
  const percent = Number.parseFloat(value.slice(0, idx)) / 100;

  if (percent === 0) {
    return value;
  }

  return `calc(${value} - ${resizersSize}px*${percent})`;
}

/**
 * Convert the provided value to the desired unit
 */
function convertToUnit(size: number, unit: string, containerSize: number) {
  switch (unit) {
    case '%':
      return `${((size / containerSize) * 100).toFixed(2)}%`;
    case 'ratio':
      return (size * 100).toFixed(0);
    default:
      return `${size.toFixed(2)}px`;
  }
}

/**
 * The default column style component created as an emotion styled component.
 */
const ColumnStyle = styled.div`
  display: flex;
  height: 100%;
  flex-direction: column;
  flex: 1;
  outline: none;
  overflow: hidden;
  user-select: text;
`;

/**
 * The default row style component created as an emotion styled component.
 */
const RowStyle = styled.div`
  display: flex;
  height: 100%;
  flex-direction: row;
  flex: 1;
  outline: none;
  overflow: hidden;
  user-select: text;
`;

/**
 * Create the pane styles.
 */
function createPaneStyle(props: PaneStyle) {
  const { split, initialSize, size, minSize, maxSize, resizersSize } = props;

  const value = size ?? initialSize;
  const vertical = split === 'vertical';

  const styleProp = {
    minSize: vertical ? 'minWidth' : 'minHeight',
    maxSize: vertical ? 'maxWidth' : 'maxHeight',
    size: vertical ? 'width' : 'height',
  } as const;

  const style: CSSProperties = {
    display: 'flex',
    outline: 'none',
  };

  style[styleProp.minSize] = convertSizeToCssValue(minSize, resizersSize);
  style[styleProp.maxSize] = convertSizeToCssValue(maxSize, resizersSize);

  switch (getUnit(value)) {
    case 'ratio':
      style.flex = value;
      break;
    default:
      style.flexGrow = 0;
      style[styleProp.size] = convertSizeToCssValue(value, resizersSize);
      break;
  }

  return style;
}

/**
 * Checks whether this is a pane element.
 */
function isPaneElement(value: unknown): value is ReactElement<PropsWithChildren<PaneProps>> {
  return isObject(value) && value.type === Pane;
}

/**
 * Loop through the child components and retrieve all available props.
 */
function getPanePropSizes(children: ReactNode) {
  return removeNullChildren(children).map((child) => {
    invariant(isValidElement(child), {
      message: 'Something went wrong in the Playground. This should not error.',
    });

    const value = child.props.size ?? child.props.initialSize;

    if (isUndefined(value)) {
      return DEFAULT_PANE_SIZE;
    }

    return String(value);
  });
}

/**
 * Get the dimensions snapshot for this component
 */
function getDimensionsSnapshot(options: GetDimensionSnapshotOptions): DimensionsSnapshot {
  const { children, splitPane, split, paneElements, previousResizersSize } = options;

  const paneDimensions = getPaneDimensions(paneElements);
  const splitPaneDimensions = splitPane.getBoundingClientRect();
  const minSizes = getPanePropMinMaxSize(children, 'minSize');
  const maxSizes = getPanePropMinMaxSize(children, 'maxSize');

  const resizerSize = getResizersSize(removeNullChildren(children), previousResizersSize);
  const splitPaneSizePx =
    split === 'vertical'
      ? splitPaneDimensions.width - resizerSize
      : splitPaneDimensions.height - resizerSize;

  const minSizesPx = minSizes.map((size) => convert(size, splitPaneSizePx));
  const maxSizesPx = maxSizes.map((size) => convert(size, splitPaneSizePx));
  const sizesPx = paneDimensions.map((domRect) =>
    split === 'vertical' ? domRect.width : domRect.height,
  );

  return {
    resizerSize,
    paneDimensions,
    splitPaneSizePx,
    minSizesPx,
    maxSizesPx,
    sizesPx,
  };
}

/**
 * Get the min or max size of the pane prop.
 */
function getPanePropMinMaxSize(children: ReactNode, key: 'minSize' | 'maxSize') {
  return removeNullChildren(children).map((child) => {
    invariant(isValidElement(child), {
      message: 'Something went wrong in the Playground. This should not error.',
    });

    const value = child.props[key];

    if (value === undefined) {
      return key === 'maxSize' ? DEFAULT_PANE_MAX_SIZE : DEFAULT_PANE_MIN_SIZE;
    }

    return value as string;
  });
}

/**
 * Get the dimensions of each active pane element.
 */
function getPaneDimensions(paneElements: HTMLElement[]) {
  const dimensions: DOMRect[] = [];

  for (const element of paneElements) {
    if (!element) {
      continue;
    }

    dimensions.push(element.getBoundingClientRect());
  }

  return dimensions;
}

/**
 * Get the size of the resizers.
 */
function getResizersSize(children: ReactNode[], resizerSize: number) {
  return (children.length - 1) * resizerSize;
}

// export const SplitPane = styled.div`
//   background-color: red;
// `;
// export const Pane = styled.div``;
