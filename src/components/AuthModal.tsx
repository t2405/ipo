import React, { useState, useEffect } from "react";
import { X, Sparkles, Loader2, Chrome } from "lucide-react";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Listen to message events for the Google OAuth popup callback
  useEffect(() => {
    const completeLogin = (payload: any) => {
      const { accessToken, refreshToken, user } = payload;

      localStorage.setItem("iposense_access_token", accessToken);
      localStorage.setItem("iposense_refresh_token", refreshToken);

      const normalizedUser = {
        ...user,
        displayName: user.displayName || user.name || "",
        name: user.name || user.displayName || "",
        photoURL: user.photoURL || "",
      };

      localStorage.setItem("iposense_user", JSON.stringify(normalizedUser));
      window.dispatchEvent(new Event("iposense_auth_changed"));

      setSuccessMsg(`Welcome back, ${normalizedUser.name}! Connected via Google SSO.`);
      setLoading(false);

      setTimeout(() => {
        onSuccess?.();
        onClose();
        window.location.reload();
      }, 500);
    };

    const handleOAuthMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        completeLogin(event.data);
      }
    };
    window.addEventListener("message", handleOAuthMessage);
    const channel = new BroadcastChannel("iposense-auth");
    channel.onmessage = (event) => {
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        completeLogin(event.data);
      }
    };
    return () => {
      window.removeEventListener("message", handleOAuthMessage);
      channel.close();
    };
  }, [onSuccess, onClose]);

  if (!isOpen) return null;

  // Google SSO via Popup with postMessage callback
  const handleGoogleAuth = async () => {
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      // Fetch Google OAuth URL from the custom backend
      const res = await fetch("/api/auth/google-url");
      const data = await res.json();

      if (!data.url) {
        throw new Error("Failed to construct Google OAuth Gateway URL");
      }

      // Open OAuth in a popup window (safe inside iframe contexts)
      const width = 500;
      const height = 650;
      const left = window.screen.width / 2 - width / 2;
      const top = window.screen.height / 2 - height / 2;

      const popup = window.open(
        data.url,
        "Google Sign-In",
        `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`
      );

      if (!popup) {
        throw new Error("Popup blocked by browser. Please enable popups to login with Google.");
      }
    } catch (err: any) {
      console.error("Google SSO popup failed:", err);
      setError(err.message || "Google Single Sign-On failed");
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-background/80 backdrop-blur-sm">
      <div className="relative w-full max-w-[340px] xs:max-w-sm sm:max-w-md bg-card border border-border rounded-2xl sm:rounded-3xl shadow-2xl shadow-black/40 p-5 sm:p-8 overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Animated Accent Line */}
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-violet-500 to-primary"></div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 sm:top-4 sm:right-4 p-1.5 rounded-lg border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Modern Header */}
        <div className="flex flex-col items-center text-center gap-2 sm:gap-3 mt-1 sm:mt-2 mb-2">
          <div className="rounded-full bg-gradient-to-tr from-primary via-violet-500 to-primary shadow-xl p-3 sm:p-4 mb-1 sm:mb-2 flex items-center justify-center">
            <Sparkles className="h-6 w-6 sm:h-8 sm:w-8 text-white drop-shadow" />
          </div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            Welcome to IPO Sense AI
          </h2>
          <p className="text-xs sm:text-sm text-muted-foreground max-w-[320px] leading-relaxed">
            Sign in securely with your Google account to access IPO analytics, portfolio tracking, and AI-powered insights.
          </p>
        </div>

        {/* Feature badges */}
        <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2 my-3 sm:my-4">
          <span className="px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-full bg-muted text-[10px] sm:text-xs font-semibold text-foreground/80 border border-border whitespace-nowrap">
            Secure Login
          </span>
          <span className="px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-full bg-muted text-[10px] sm:text-xs font-semibold text-foreground/80 border border-border whitespace-nowrap">
            Cloud Sync
          </span>
          <span className="px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-full bg-muted text-[10px] sm:text-xs font-semibold text-foreground/80 border border-border whitespace-nowrap">
            AI Insights
          </span>
        </div>

        {/* Feedback Messages */}
        {error && (
          <div className="mb-3 p-2.5 rounded-xl border border-destructive/30 bg-destructive/10 text-xs text-destructive text-center leading-relaxed">
            {error}
          </div>
        )}

        {successMsg && (
          <div className="mb-3 p-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-500 text-center leading-relaxed">
            {successMsg}
          </div>
        )}

        {/* Google Sign-In Button */}
        <button
          onClick={handleGoogleAuth}
          disabled={loading}
          type="button"
          className="w-full py-2.5 sm:py-3 mt-1 sm:mt-2 bg-primary text-primary-foreground hover:bg-primary/90 text-sm sm:text-base font-bold rounded-xl flex items-center justify-center space-x-2 shadow-md transition-all cursor-pointer disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 sm:h-5 sm:w-5 animate-spin" />
          ) : (
            <>
              <Chrome className="h-4 w-4 sm:h-5 sm:w-5 text-primary-foreground shrink-0" />
              <span>Continue with Google</span>
            </>
          )}
        </button>

        {/* Terms & Privacy */}
        <div className="text-[10px] sm:text-xs text-muted-foreground text-center mt-3 sm:mt-4 leading-normal">
          By continuing, you agree to the Terms of Service and Privacy Policy.
        </div>
      </div>
    </div>
  );
}