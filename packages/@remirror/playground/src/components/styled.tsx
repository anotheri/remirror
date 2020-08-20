/** @jsx jsx */
import { jsx } from '@emotion/core';
import styled from '@emotion/styled';
import type { FC } from 'react';

export const StyledContainer = styled.div`
  width: 100%;
  height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  /* overflow: hidden; */
`;

export const Main: FC = styled.div`
  flex: 1px;
  display: flex;
  background-color: #222437;
  overflow: hidden;
`;

export const Panel: FC<{ flex?: string; vertical?: boolean; overflow?: boolean }> = function ({
  children,
  flex = '1 0 0',
  vertical,
  overflow = false,
}) {
  return (
    <div
      style={{
        height: '100%',
        flex,
        display: 'flex',
        flexDirection: vertical ? 'column' : 'row',
        overflow: overflow ? 'auto' : 'hidden',
      }}
    >
      {children}
    </div>
  );
};

export const Divide: FC = function () {
  return <div style={{ backgroundColor: 'black', flex: '0 0 1px' }}></div>;
};
