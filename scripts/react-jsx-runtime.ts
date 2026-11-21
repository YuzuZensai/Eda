import * as runtime from "react/jsx-runtime";

// Bind the CommonJS exports once so each JSX expression can call an ESM binding directly.
export const { jsx, jsxs, Fragment } = runtime;
