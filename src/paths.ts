import {fileURLToPath} from 'node:url';

// Compiled to dist/src/paths.js in both the checkout and the installed package.
// This is the Stratos package directory, independent of the caller's workspace.
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
