import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import { I18nProvider } from "./i18n/i18n";
import { initializeDensity } from "./theme/density";
import { initializeTheme } from "./theme/theme";
import "./index.css";
import "./future-theme.css";
import "./aesthetic-v2.css";

initializeTheme();
initializeDensity();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 8_000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
