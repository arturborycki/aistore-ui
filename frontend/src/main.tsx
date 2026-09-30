import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setNonce } from 'get-nonce'
import { ApiError } from '@/lib/api'
import { getPref } from '@/lib/prefs'
import { AuthProvider } from '@/auth/AuthContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ToastProvider } from '@/components/ui/toast'
import { applyTheme, ThemeProvider, type ThemePref } from '@/layout/theme'
import { App } from './App'
import { ChangeSetProvider } from '@/features/changeset/ChangeSet'
import './index.css'

// The server injects a per-response CSP nonce; libraries that create <style>
// elements at runtime (scroll locking in dialogs) pick it up from here.
const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content
if (nonce && nonce !== '__CSP_NONCE__') setNonce(nonce)

applyTheme(getPref<ThemePref>('theme', 'system'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Do not retry authorisation decisions or missing resources.
      retry: (count, err) => !(err instanceof ApiError && [400, 401, 403, 404, 409].includes(err.status)) && count < 2,
    },
    mutations: { retry: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <AuthProvider>
                <ChangeSetProvider>
                  <App />
                </ChangeSetProvider>
              </AuthProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
