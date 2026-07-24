import React from "react";

export default function SocialAnalyzer() {
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-foreground">Social Analyzer</h2>
          <p className="text-xs text-muted-foreground">Social sentiment intelligence remains available through the existing API layer and frontend signals.</p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Signal Status</p>
          <p className="mt-2 text-base font-semibold text-foreground">Operational</p>
        </div>
        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Mode</p>
          <p className="mt-2 text-base font-semibold text-foreground">Request-driven</p>
        </div>
      </div>
    </section>
  );
}