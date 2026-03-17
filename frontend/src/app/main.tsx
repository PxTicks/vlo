import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Polyfill for explicit resource management
// @ts-expect-error - mixed support
Symbol.dispose ??= Symbol("Symbol.dispose");
// @ts-expect-error - mixed support
Symbol.asyncDispose ??= Symbol("Symbol.asyncDispose");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
