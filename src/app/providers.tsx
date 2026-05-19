import { type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { BrowserRouter } from 'react-router-dom';
import { store, persistor } from '@kernel/application';
import { ThemeProvider } from '@shared/lib/theme';
import { LoadingSpinner, ToastProvider } from '@shared/ui';

// Create a client for TanStack Query
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 30, // 30 minutes (formerly cacheTime)
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

interface AppProvidersProps {
  children: ReactNode;
}

/**
 * App Providers - Wraps the entire app with necessary providers
 * Order matters: outermost providers are listed first
 * 
 * Provider hierarchy:
 * 1. Redux Provider - Global state management
 * 2. PersistGate - Delays rendering until persisted state is retrieved
 * 3. QueryClientProvider - Server state management (TanStack Query)
 * 4. BrowserRouter - Client-side routing
 * 5. ThemeProvider - Theme management
 */
export function AppProviders({ children }: AppProvidersProps) {
  return (
    <Provider store={store}>
      <PersistGate loading={<LoadingSpinner fullScreen />} persistor={persistor}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <ThemeProvider defaultTheme="system" storageKey="app-theme">
              <ToastProvider>{children}</ToastProvider>
            </ThemeProvider>
          </BrowserRouter>
          <ReactQueryDevtools initialIsOpen={false} />
        </QueryClientProvider>
      </PersistGate>
    </Provider>
  );
}
