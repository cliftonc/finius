import { HeroUIProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { AuthError } from "./api";
import { ThemeProvider } from "./theme";
import { App } from "./ui/App";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      // Don't retry auth failures — surface them immediately so the login screen shows without delay.
      retry: (count, error) => !(error instanceof AuthError) && count < 3
    }
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <HeroUIProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </HeroUIProvider>
    </ThemeProvider>
  </React.StrictMode>
);
