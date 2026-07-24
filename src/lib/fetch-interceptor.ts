// Extend window interface for csrfToken
declare global {
  interface Window {
    csrfToken?: string;
  }
}

import { auth } from "./firebase.js";

const originalFetch = window.fetch;

// Helper to check and refresh token
async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = localStorage.getItem("iposense_refresh_token");
  if (!refreshToken) return null;

  try {
    const res = await originalFetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.accessToken) {
        localStorage.setItem("iposense_access_token", data.accessToken);
        // Persist the rotated refresh token returned by the server
        if (data.refreshToken) {
          localStorage.setItem("iposense_refresh_token", data.refreshToken);
        }
        return data.accessToken;
      }
    }
  } catch (err) {
    console.error("Failed to refresh access token automatically:", err);
  }

  // Clear session if refresh failed
  localStorage.removeItem("iposense_access_token");
  localStorage.removeItem("iposense_refresh_token");
  localStorage.removeItem("iposense_user");
  window.dispatchEvent(new Event("iposense_auth_changed"));
  return null;
}

async function customFetch(this: any, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url);
  
  let fetchInit = init ? { ...init } : {};
  const isApiRequest = url.startsWith("/api") || 
                       url.startsWith("http://localhost:3000/api") || 
                       url.startsWith(window.location.origin + "/api");

  const method = (fetchInit.method || "GET").toUpperCase();

  if (isApiRequest) {
    // 1. Transparent CSRF Token Auto-injection for modifying requests
    const isWriteOperation = ["POST", "PUT", "DELETE", "PATCH"].includes(method);
    const isCsrfFetchRoute = url.includes("/api/auth/csrf-token");

    if (isWriteOperation && !isCsrfFetchRoute) {
      if (!window.csrfToken) {
        try {
          const csrfRes = await originalFetch("/api/auth/csrf-token");
          if (csrfRes.ok) {
            const csrfData = await csrfRes.json();
            window.csrfToken = csrfData.csrfToken;
          }
        } catch (csrfErr) {
          console.warn("[CSRF Interceptor] Failed retrieving CSRF token on demand:", csrfErr);
        }
      }

      if (window.csrfToken) {
        const headers = new Headers(fetchInit.headers || {});
        headers.set("X-CSRF-Token", window.csrfToken);
        fetchInit.headers = headers;
      }
    }

    // 2. JWT Access Token injection
    let token: string | null = null;

    // Check custom JWT first
    const customToken = localStorage.getItem("iposense_access_token");
    if (customToken) {
      token = customToken;
    } else {
      // Fallback to Firebase
      const currentUser = auth.currentUser;
      if (currentUser) {
        try {
          token = await currentUser.getIdToken();
        } catch (err) {
          console.error("Failed to get Firebase ID token:", err);
        }
      }
    }

    if (token) {
      const headers = new Headers(fetchInit.headers || {});
      headers.set("Authorization", `Bearer ${token}`);
      fetchInit.headers = headers;
    }
  }
  
  const response = await originalFetch.call(this, input, fetchInit);

  // If unauthorized because of expired token, try silent refresh
  if (response.status === 401 && isApiRequest) {
    const responseClone = response.clone();
    try {
      const body = await responseClone.json();
      if (body.error === "UNAUTHORIZED_EXPIRED") {
        console.log("Access token expired. Requesting automatic token refresh...");
        const newAccessToken = await refreshAccessToken();
        if (newAccessToken) {
          const headers = new Headers(fetchInit.headers || {});
          headers.set("Authorization", `Bearer ${newAccessToken}`);
          fetchInit.headers = headers;
          return originalFetch.call(this, input, fetchInit);
        }
      }
    } catch (_) {
      // Safe fallback if response is not JSON
    }
  }

  return response;
}

try {
  Object.defineProperty(window, "fetch", {
    value: customFetch,
    writable: true,
    configurable: true,
    enumerable: true
  });
} catch (err) {
  console.warn("Failed to define property 'fetch' on window. Attempting direct assignment...", err);
  try {
    (window as any).fetch = customFetch;
  } catch (err2) {
    console.error("Direct assignment to window.fetch also failed:", err2);
  }
}
