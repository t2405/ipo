// Extend window interface for csrfToken
declare global {
  interface Window {
    csrfToken?: string;
  }
}

const originalFetch = window.fetch;

// Helper to check and refresh token
async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = localStorage.getItem("iposense_refresh_token");
  if (!refreshToken) return null;

  try {
    const res = await originalFetch("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (res.ok) {
      const data = await res.json();

      if (data.accessToken) {
        localStorage.setItem("iposense_access_token", data.accessToken);

        if (data.refreshToken) {
          localStorage.setItem(
            "iposense_refresh_token",
            data.refreshToken
          );
        }

        return data.accessToken;
      }
    }
  } catch (err) {
    console.error("Failed to refresh access token automatically:", err);
  }

  // Refresh failed → clear session
  localStorage.removeItem("iposense_access_token");
  localStorage.removeItem("iposense_refresh_token");
  localStorage.removeItem("iposense_user");

  window.dispatchEvent(new Event("iposense_auth_changed"));

  return null;
}

async function customFetch(
  this: any,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

  let fetchInit: RequestInit = init ? { ...init } : {};

  const isApiRequest =
    url.startsWith("/api") ||
    url.startsWith("http://localhost:3000/api") ||
    url.startsWith(window.location.origin + "/api");

  const method = (fetchInit.method || "GET").toUpperCase();

  if (isApiRequest) {
    // -----------------------------
    // CSRF Auto Injection
    // -----------------------------
    const isWriteOperation = ["POST", "PUT", "PATCH", "DELETE"].includes(
      method
    );

    const isCsrfFetchRoute = url.includes("/api/auth/csrf-token");

    if (isWriteOperation && !isCsrfFetchRoute) {
      if (!window.csrfToken) {
        try {
          const csrfRes = await originalFetch("/api/auth/csrf-token");

          if (csrfRes.ok) {
            const csrfData = await csrfRes.json();
            window.csrfToken = csrfData.csrfToken;
          }
        } catch (err) {
          console.warn(
            "[CSRF Interceptor] Failed retrieving CSRF token:",
            err
          );
        }
      }

      if (window.csrfToken) {
        const headers = new Headers(fetchInit.headers || {});
        headers.set("X-CSRF-Token", window.csrfToken);
        fetchInit.headers = headers;
      }
    }

    // -----------------------------
    // JWT Access Token Injection
    // -----------------------------
    const token = localStorage.getItem("iposense_access_token");

    if (token) {
      const headers = new Headers(fetchInit.headers || {});
      headers.set("Authorization", `Bearer ${token}`);
      fetchInit.headers = headers;
    }
  }

  let response = await originalFetch.call(this, input, fetchInit);

  // -----------------------------
  // Auto Refresh Expired Token
  // -----------------------------
  if (response.status === 401 && isApiRequest) {
    try {
      const clone = response.clone();
      const body = await clone.json();

      if (body.error === "UNAUTHORIZED_EXPIRED") {
        console.log("Access token expired. Refreshing...");

        const newToken = await refreshAccessToken();

        if (newToken) {
          const headers = new Headers(fetchInit.headers || {});
          headers.set("Authorization", `Bearer ${newToken}`);
          fetchInit.headers = headers;

          response = await originalFetch.call(this, input, fetchInit);
        }
      }
    } catch {
      // Ignore non-JSON responses
    }
  }

  return response;
}

try {
  Object.defineProperty(window, "fetch", {
    value: customFetch,
    writable: true,
    configurable: true,
    enumerable: true,
  });
} catch (err) {
  console.warn(
    "Failed to override window.fetch. Trying direct assignment...",
    err
  );

  try {
    (window as any).fetch = customFetch;
  } catch (err2) {
    console.error("Failed to override fetch:", err2);
  }
}