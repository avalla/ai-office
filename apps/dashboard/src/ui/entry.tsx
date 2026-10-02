import { createRoot } from "react-dom/client";
import { App } from "../app/app.tsx";

const root = document.getElementById("app");
if (root === null) throw new Error("The dashboard root is missing");
createRoot(root).render(<App />);
