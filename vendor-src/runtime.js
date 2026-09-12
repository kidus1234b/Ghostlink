// Single bundle holding React, the React DOM client and htm, so that every
// specifier the page imports resolves to one React instance. Splitting them
// into separate bundles would give react-dom its own private copy of React and
// break hooks.
import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import htm from 'htm';

export { React, ReactDOMClient, htm };
