/**
 * @packageDocumentation
 *
 * This file contains the code editor which is used to render the playground
 * code when in advanced mode. It has quite a large footprint, requiring the
 * loading of multiple dts files.
 *
 * This code editor will be loaded asynchronously due to it's size. It will provide the editor
 */

import styled from '@emotion/styled';
import type { editor } from 'monaco-editor';
import React, { FC, useEffect, useMemo, useRef } from 'react';

import { selectors, usePlaygroundState } from '../playground-state';

/**
 * This editor is a shallow wrapper around the monaco editor. It should be
 * loaded only when required as it requires a lot.
 *
 * It should only be added to the dom after everything has been loaded.
 */
export const PlaygroundCodeEditor: FC = () => {
  const { singleton, value, readOnly, setValue } = usePlaygroundState(selectors.code);

  // This is the container div for the code editor.
  const containerRef = useRef<HTMLDivElement | null>(null);

  // This is the model that handles the editor data.
  const model = useMemo(() => singleton.getModel(''), [singleton]);

  // Handles the local instance of the editor.
  const editorRef = useRef<editor.IStandaloneCodeEditor>();

  // Clean up the model when the component is unmounted.
  useEffect(() => {
    return () => {
      model.dispose();
    };
  }, [model]);

  // Attach the editor to the dom if and when the container is mounted.
  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    // Attach the monaco editor to the dom and save the reference to the editor.
    const editor = singleton.createEditorAndAttach(containerRef.current, model);
    editorRef.current = editor;

    editor.onDidChangeModelContent(singleton.createTypeGetter(model));

    return () => {
      editor.dispose();
    };
  }, [singleton, model]);

  // Update the readonly status of the editor.
  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    editorRef.current.updateOptions({ readOnly });
  }, [readOnly]);

  // Update the monaco editor value when the value state is updated. The state
  // can be updated by prettier or toggling between configuration and advanced
  // mode.
  useEffect(() => {
    if (model.getValue() === value) {
      return;
    }

    model.setValue(value);
  }, [model, value]);

  // Update the layout of the editor in response to the window size changing.
  useEffect(() => {
    return singleton.handleLayout(editorRef.current);
  }, [singleton]);

  // Listen for changes to the editor content.
  useEffect(() => {
    model.onDidChangeContent((_event) => {
      setValue(model.getValue());
    });
  }, [model, setValue]);

  return <StyledContainer ref={containerRef} />;
};

/**
 * The styled container which will be used to hold onto the editor.
 */
const StyledContainer = styled.div`
  flex: 1;
  overflow: hidden;
  background-color: transparent;
`;
