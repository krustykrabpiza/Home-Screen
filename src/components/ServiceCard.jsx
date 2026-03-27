const stateMeta = {
  online: { label: "Online", className: "status-online" },
  update: { label: "Update", className: "status-update" },
  degraded: { label: "Degraded", className: "status-degraded" },
  offline: { label: "Offline", className: "status-offline" },
  unknown: { label: "Unknown", className: "status-unknown" },
};

function formatMetricValue(value, suffix) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return `${value.toFixed(1)}${suffix}`;
}

export default function ServiceCard({ service, status }) {
  const effectiveState = status?.updateAvailable ? "update" : status?.state;
  const state = stateMeta[effectiveState] ?? stateMeta.unknown;
  const netIn = formatMetricValue(status?.metrics?.netInMbps, " Mbps");
  const netOut = formatMetricValue(status?.metrics?.netOutMbps, " Mbps");
  const cpu = formatMetricValue(status?.metrics?.cpuPct, "%");
  const mem = formatMetricValue(status?.metrics?.memPct, "%");
  const sourceSummary = status?.sourceSummary ? `Source ${status.sourceSummary}` : null;
  const confidence =
    typeof status?.confidencePct === "number" ? `Confidence ${status.confidencePct}%` : null;
  const freshness = status?.stale ? "Stale data" : null;

  return (
    <a
      className="service-card"
      href={service.link}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${service.name}`}
    >
      <div className="card-head">
        <span className="service-icon" aria-hidden>
          {service.icon}
        </span>
        <div className="service-title-wrap">
          <h3 className="service-title">{service.name}</h3>
          <span className={`status-pill ${state.className}`}>
            <span className="status-dot" aria-hidden />
            {state.label}
          </span>
        </div>
      </div>
      <p className="service-description">{service.description}</p>
      <p className="service-detail">{status?.detail ?? "No details available"}</p>
      {netIn || netOut || cpu || mem ? (
        <p className="service-metrics">
          {netIn ? `Down ${netIn}` : "Down --"} | {netOut ? `Up ${netOut}` : "Up --"} |{" "}
          {cpu ? `CPU ${cpu}` : "CPU --"} | {mem ? `Mem ${mem}` : "Mem --"}
        </p>
      ) : null}
      {sourceSummary || confidence || freshness ? (
        <p className="service-meta">
          {sourceSummary ?? "Source --"} | {confidence ?? "Confidence --"}
          {freshness ? ` | ${freshness}` : ""}
        </p>
      ) : null}
    </a>
  );
}
