import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installChrome } from "./lib/chrome";
import "./styles.css";

installChrome(document, import.meta.env.PROD);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
