import React from "react";
import ReactDOM from "react-dom/client";
import "@carbon/styles/css/styles.css";
import "@fontsource/orbitron";
import App from "./App";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
